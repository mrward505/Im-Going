import type { Pool, PoolClient } from "pg";

/**
 * Typed queries over the spec §4 relations. The migration owns the DDL;
 * this file centralises all SQL row-shapes and lookups for reuse.
 */
import { effectiveStars } from "./lib/reputation";
import { eventWindow } from "./lib/geofence";

export interface UserRow {
  id: string;
  phone: string;
  dob: string; // date as ISO yyyy-mm-dd
  display_name: string;
  username: string;
  city: string;
  reputation_points: number;
  star_rating: number;
  verified_checkin_count: number;
  location_permission_granted: boolean;
  created_at: string;
  deleted_at: string | null;
}

export interface SpotRow {
  id: string;
  name: string;
  address: string | null;
  lat: number;
  lon: number;
  geofence_radius_m: number;
  category: string;
  is_verified: boolean;
  is_large_venue: boolean;
  city: string;
  created_by: string | null;
  created_at: string;
}

export interface EventRow {
  id: string;
  spot_id: string;
  start_at: string;
  default_end: string;
  note: string | null;
  created_by: string | null;
  status: string;
  created_at: string;
  spot?: SpotRow;
}

export interface GoingRow {
  id: string;
  event_id: string;
  user_id: string;
  status: string;
  settlement_kind: string | null; // Slice 3: showup | no_show | soft_no_show | free_cancel | unverifiable
  settled_at: string | null;
  created_at: string;
}

export const publicSpotSelect = `
  s.id, s.name, s.address, s.lat, s.lon, s.geofence_radius_m, s.category,
  s.is_verified, s.is_large_venue, s.city, s.created_by, s.created_at`;

export async function findUserByPhone(pool: Pool, phone: string): Promise<UserRow | undefined> {
  const { rows } = await pool.query<UserRow>("SELECT * FROM users WHERE phone = $1 AND deleted_at IS NULL", [phone]);
  return rows[0];
}

export async function findUserById(pool: Pool, id: string): Promise<UserRow | undefined> {
  const { rows } = await pool.query<UserRow>("SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL", [id]);
  return rows[0];
}

export async function findSpotById(pool: Pool, id: string): Promise<SpotRow | undefined> {
  const { rows } = await pool.query<SpotRow>(`SELECT ${publicSpotSelect} FROM spots s WHERE s.id = $1`, [id]);
  return rows[0];
}

export async function findEventById(pool: Pool, id: string): Promise<EventRow | undefined> {
  const { rows } = await pool.query<EventRow>(
    `SELECT e.id, e.spot_id, e.start_at, e.default_end, e.note, e.created_by, e.status, e.created_at
     FROM events e WHERE e.id = $1`,
    [id],
  );
  return rows[0];
}

/** The public model of a user (what the API returns). Uses effectiveStars (3.0 cap until first check-in). */
export function serializeUser(u: UserRow): Record<string, unknown> {
  return {
    id: u.id,
    phone: u.phone,
    display_name: u.display_name,
    username: u.username,
    city: u.city,
    reputation_points: u.reputation_points,
    star_rating: effectiveStars(u.reputation_points, u.verified_checkin_count),
    verified_checkin_count: u.verified_checkin_count,
    created_at: u.created_at,
  };
}

/**
 * Mask a spot for a viewer. Custom (unverified) spots return masked_address
 * and NO pin; the exact address + pin unlock only for confirmed attendees
 * (spec §2b owner rule). Verified POI spots are public. `confirmed` must be
 * supplied by the caller based on the viewer's Going row on the relevant event.
 */
export interface SpotForViewer {
  id: string;
  name: string;
  masked_address: string | null;
  address: string | null;
  lat?: number;
  lon?: number;
  geofence_radius_m: number;
  category: string;
  is_verified: boolean;
  is_large_venue: boolean;
  city: string;
}

export function serializeSpotRaw(
  s: Pick<SpotRow, "id" | "name" | "address" | "lat" | "lon" | "geofence_radius_m" | "category" | "is_verified" | "is_large_venue" | "city">,
  viewer: { confirmed: boolean },
): SpotForViewer {
  const isCustom = !s.is_verified;
  const confirmed = !isCustom || viewer.confirmed;
  return {
    id: s.id,
    name: s.name,
    masked_address: isCustom ? `Private spot in ${s.city}` : null,
    address: confirmed ? s.address : null,
    ...(confirmed ? { lat: s.lat, lon: s.lon } : {}),
    geofence_radius_m: s.geofence_radius_m,
    category: s.category,
    is_verified: s.is_verified,
    is_large_venue: s.is_large_venue,
    city: s.city,
  };
}

export interface EventForViewer {
  id: string;
  spot: SpotForViewer;
  start_at: string;
  default_end: string;
  note: string | null;
  status: string;
  window: { start: string; end: string };
  going_count: number;
  my_going: boolean;
}

export async function serializeEventForViewer(
  pool: Pool,
  event: EventRow,
  spot: SpotRow,
  viewerId: string | null,
  now: Date = new Date(),
): Promise<EventForViewer> {
  const [{ rows: goingRows }, goingCount, myGoing] = await Promise.all([
    pool.query<GoingRow>("SELECT id, event_id, user_id, status, settlement_kind, settled_at, created_at FROM going WHERE event_id = $1 AND status = 'active' ORDER BY created_at", [event.id]),
    pool.query<{ n: number }>("SELECT count(*)::int AS n FROM going WHERE event_id = $1 AND status = 'active'", [event.id]),
    viewerId
      ? pool.query<{ n: number }>("SELECT count(*)::int AS n FROM going WHERE event_id = $1 AND user_id = $2 AND status = 'active'", [event.id, viewerId])
      : Promise.resolve({ rows: [] as { n: number }[] }),
  ]);
  void goingRows;
  const w = eventWindow(event.start_at, now);
  const confirmed = myGoing.rows[0]?.n === 1;
  return {
    id: event.id,
    spot: serializeSpotRaw(spot, { confirmed }),
    start_at: event.start_at,
    default_end: event.default_end,
    note: event.note,
    status: event.status,
    window: { start: w.start.toISOString(), end: w.end.toISOString() },
    going_count: goingCount.rows[0]?.n ?? 0,
    my_going: confirmed,
  };
}

export async function getGoingRow(
  client: Pool | PoolClient,
  eventId: string,
  userId: string,
): Promise<GoingRow | undefined> {
  const { rows } = await client.query<GoingRow>(
    "SELECT id, event_id, user_id, status, settlement_kind, settled_at, created_at FROM going WHERE event_id = $1 AND user_id = $2",
    [eventId, userId],
  );
  return rows[0];
}

// --- posts / moderation (Slice 4d-1, spec §2f/§4) -----------------------------

export interface PostRow {
  id: string;
  event_id: string;
  check_in_id: string;
  user_id: string;
  spot_id: string;
  type: string; // 'image' | 'video' (DB CHECK)
  caption: string | null;
  object_key: string;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  created_at: string;
}

export interface FeedRow extends PostRow {
  event: { id: string; start_at: string; status: string; going_count: number };
  poster: { id: string; display_name: string; star_rating: number };
  spot_is_verified: boolean;
}

export interface SerializedPost {
  id: string;
  event_id: string;
  check_in_id: string;
  user_id: string;
  spot_id: string;
  type: "image" | "video";
  caption: string | null;
  object_key: string;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  media_url: string | null;
  created_at: string;
}

/**
 * Serialize a post (create response) or a feed row (with event/poster joins —
 * the extra columns ride along harmlessly on the base shape). media_url comes
 * from the active storage provider's getPublicUrl (null for foreign keys).
 */
export function serializePostForViewer(
  post: PostRow,
  opts: { media_url: string | null },
): SerializedPost {
  return {
    id: post.id,
    event_id: post.event_id,
    check_in_id: post.check_in_id,
    user_id: post.user_id,
    spot_id: post.spot_id,
    type: post.type === "video" ? "video" : "image",
    caption: post.caption,
    object_key: post.object_key,
    width: post.width,
    height: post.height,
    duration_s: post.duration_s,
    media_url: opts.media_url,
    created_at: post.created_at,
  };
}

/**
 * The Live feed groups by spot, so the poster's display identity rides on the
 * post row (spec §2f: display_name + star_rating next to each post).
 */
export interface FeedPoster {
  id: string;
  display_name: string;
  star_rating: number;
}

export function serializeFeedPoster(poster: FeedPoster): FeedPoster {
  return { id: poster.id, display_name: poster.display_name, star_rating: poster.star_rating };
}