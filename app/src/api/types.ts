/**
 * Shared API types for I'm Going — mirrored 1:1 from the server's response
 * shapes (server/src/db.ts serializers + routes). Keep in sync when the
 * backend contract changes.
 *
 * Slice 4b note: the 4a draft of this file was aspirational (going lists,
 * posts, is_custom/created_by/confirmed flags). The server actually returns
 * masked SpotForViewer cards + lean EventForViewer rows — this file now
 * matches the wire reality.
 */

export interface ApiErrorBody {
  error: { code: string; message: string };
}

/** /api/v1/auth/otp/request (201) — dev_code present when OTP_PROVIDER=console */
export interface OtpRequestResponse {
  request_id: string;
  expires_at: string;
  provider: string;
  dev_code?: string;
}

export type SettlementKind =
  | "showup"
  | "no_show"
  | "soft_no_show"
  | "free_cancel"
  | "unverifiable";

/** /api/v1/auth/otp/verify — existing user → login; new user → signup token */
export type OtpVerifyResponse =
  | { type: "login"; token: string; user: User }
  | { type: "signup"; signup_token: string };

/** /api/v1/auth/register (201) */
export interface RegisterResponse {
  token: string;
  user: User;
}

/** GET /api/v1/me */
export interface MeResponse {
  user: User;
}

/** serializeUser (server/src/db.ts) — note: no dob on the wire. */
export interface User {
  id: string;
  phone: string;
  display_name: string;
  username: string;
  city: string;
  reputation_points: number;
  star_rating: number; // 1.0–5.0
  verified_checkin_count: number;
  created_at: string;
}

/** Spot.category CHECK: bar|club|concert|restaurant|house|other */
export type SpotCategory =
  | "bar"
  | "club"
  | "concert"
  | "restaurant"
  | "house"
  | "other";

/**
 * SpotForViewer (serializeSpotRaw). Custom (unverified) spots are masked:
 * exact address + lat/lon are absent (undefined) until the viewer confirms
 * going; masked_address carries "Private spot in [city]" (spec §2b).
 */
export interface Spot {
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

/** EventForViewer (serializeEventForViewer) — lean row, no going list. */
export interface EventView {
  id: string;
  spot: Spot;
  start_at: string;
  default_end: string;
  note: string | null;
  status: string;
  window: { start: string; end: string };
  going_count: number;
  my_going: boolean;
  /** Other active goers on the next event, excluding the viewer (Slice 4d-3a). */
  going_with_you: number | null;
}

/** GET /api/v1/trending — top-20 spots with events in the next 48 h.
 * Slice 4d-3c: each row carries the live-audience snapshot (same real-data
 * signals as spot detail) so the list can show heat badges — never invented.
 */
export interface TrendingResponse {
  trending: Array<{
    spot: Spot;
    next_start_at: string;
    going_count: number;
    trending_score: number;
    /** Bodies in the event window right now ([start−30m, start+150m]). */
    going_now: number;
    /** Raw confirmation velocity: active goings created in the last 60 min. */
    heat_count: number;
    /** 0 calm / 1 warming / 2 hot / 3 on_fire bucket from heat_count. */
    heat_level: SpotAudienceSignals["heat_level"];
  }>;
}

export type TrendingRow = TrendingResponse["trending"][number];

/** GET /api/v1/venues?q=&category=&page=&limit=&lat=&lon=&radius_m= */
export interface VenuesResponse {
  venues: Array<{
    id: string;
    name: string;
    address: string | null;
    lat: number;
    lon: number;
    geofence_radius_m: number;
    category: SpotCategory;
    is_large_venue: boolean;
    city: string;
  }>;
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}

export type Venue = VenuesResponse["venues"][number];

/**
 * REVAMP 1/2 — universal metro search (GET /api/v1/venues/search) + cities.
 * Mirrors server/src/routes/venues.ts response shapes 1:1.
 */
export type VenueSort = "name" | "trending" | "going";

export interface VenueSearchRow {
  id: string;
  name: string;
  address: string | null;
  lat: number;
  lon: number;
  geofence_radius_m: number;
  category: SpotCategory;
  is_large_venue: boolean;
  city: string;
  /** Live confirmations on active future events at this spot (real; 0 when quiet). */
  going_count: number;
  /** Same real source as going_count — the "trending" sort key. */
  trending_score: number;
  /** Meters from lat/lon when a geosearch was requested; null otherwise. */
  distance_m: number | null;
}

export interface VenuesSearchResponse {
  venues: VenueSearchRow[];
  page: number;
  limit: number;
  total: number;
  total_pages: number;
  sort: VenueSort;
}

/** GET /api/v1/cities — real metro cities with verified-venue counts. */
export interface CityRow {
  city: string;
  venue_count: number;
}

export interface CitiesResponse {
  cities: CityRow[];
}

/** GET /api/v1/spots?q=&city=&category=&limit= — bare array (masked). */
export type SpotsResponse = Spot[];

/** POST /api/v1/spots (201) — creator sees the pin. */
export interface CreateSpotResponse {
  spot: Spot;
}

/**
 * Live-audience numbers that ride on spot-detail and share-card payloads
 * (Slice 4d-3a). All derived from real Going rows, never invented.
 */
export interface SpotAudienceSignals {
  /** Bodies in the event window right now ([start−30m, start+150m]). */
  going_now: number;
  /** Raw confirmation velocity: active goings created in the last 60 min. */
  heat_count: number;
  /** 0 calm / 1 warming / 2 hot / 3 on_fire bucket from heat_count. */
  heat_level: 0 | 1 | 2 | 3;
}

/** GET /api/v1/spots/:id — masked card + next event + going state (slice 4c). */
export interface SpotDetailResponse {
  spot: Spot;
  next_event: {
    id: string;
    start_at: string;
    default_end: string;
    note: string | null;
    status: string;
  } | null;
  going_count: number;
  my_going: boolean;
  /** Viewer holds a verified check-in on the next event (gates the composer). */
  my_checked_in?: boolean;
  /** Other active goers on the next event, excluding the viewer. */
  going_with_you: number | null;
  /** Live-audience snapshot (Slice 4d-3a). */
  going_now: number;
  heat_count: number;
  heat_level: SpotAudienceSignals["heat_level"];
}
/** GET /api/v1/spots/:id/share — share-card snapshot + live share budget (slice 4c). */
export interface SpotShareResponse {
  card: {
    spot_name: string;
    category: string;
    address: string | null;
    masked_address: string | null;
    is_verified: boolean;
    city: string;
    next_start_at: string | null;
    going_count: number;
    /** Bodies in the event window right now (Slice 4d-3a). */
    going_now: number;
    /** 60-min confirmation velocity buckets 0–3. */
    heat_level: SpotAudienceSignals["heat_level"];
    creator_display_name: string | null;
  };
  share: {
    limit: number;
    remaining: number | null;
    deep_link: string;
  };
}

/** GET /api/v1/events/:id/going — who's going (spec §3.4, slice 4d-2). */
export interface GoingEntry {
  user_id: string;
  display_name: string;
  username: string;
  star_rating: number;
  is_me: boolean;
}

export interface EventGoingResponse {
  event_id: string;
  count: number;
  going: GoingEntry[];
}

/** POST /api/v1/events (201) — announce */
export interface AnnounceEventResponse {
  event: EventView;
  snapped_to_existing: boolean;
  shares_remaining: number;
}

/** POST /api/v1/events/:id/going (201) — confirm */
export interface ConfirmGoingResponse {
  event: EventView;
}

/** GET /api/v1/events/:id */
export interface EventDetailResponse {
  event: EventView;
}

/** POST /api/v1/events/:id/checkin (201) — manual GPS check-in */
export interface CheckinResponse {
  checkin_id: string;
  verified_at: string;
  spot_id: string;
  event_id: string;
  method: "manual_gps" | "passive";
  first_verified_checkin: boolean;
  settlement: {
    kind: SettlementKind;
    points_delta: number;
    reputation_points: number;
    star_rating: number;
  };
}

/** DELETE /api/v1/events/:id/going — cancel with ledger settlement */
export interface CancelGoingResponse {
  event: EventView;
  settlement: SettlementKind | null;
  points_delta: number;
  reputation_points: number;
  star_rating: number;
}

/** GET /api/v1/me/going — My Plans (slice 4b). */
export interface MyGoingRow {
  event: {
    id: string;
    spot_id: string;
    start_at: string;
    default_end: string;
    note: string | null;
    status: string;
    created_by: string | null;
    created_at: string;
  };
  spot: Spot | null;
  my_going: boolean;
  start_at: string;
  settlement_kind: SettlementKind | null;
  settled_at: string | null;
  /** Other active goers on this event, excluding me (Slice 4d-3a). */
  going_with_you: number;
  /** ISO instant the free-cancel window closes (start − 2 h, spec §2e). */
  free_cancel_until: string | null;
}

export interface MyGoingResponse {
  upcoming: MyGoingRow[];
  recent: MyGoingRow[];
}

// --- Slice 4d-3a: influencer pull ---------------------------------------------

/**
 * GET /api/v1/users/:id/pull & /api/v1/me/pull — real aggregates over the
 * user's announcements (Slice 4d-3a, "watch the room fill"). All numbers from
 * real going/events rows; nullable where there is no data yet — the client
 * must show the honest empty state, never invented numbers.
 */
export interface InfluencerPull {
  /** Events this user announced (events.created_by = user). */
  announcements_total: number;
  /** Live audience drawn: active goings on those events, own rows excluded. */
  confirmations_drawn_total: number;
  /** Showups ÷ goers with a verdict (0–100, 1 decimal). Null when no verdicts yet. */
  goers_follow_through_pct: number | null;
  /** Audience per announcement (2 decimals). Null with no announcements. */
  avg_confirmations_per_announcement: number | null;
}

export interface PullResponse {
  user_id: string;
  pull: InfluencerPull;
}

/** POST /api/v1/shares (201) / GET /api/v1/shares/budget */
export interface ShareResponse {
  limit: number;
  remaining: number;
}

// --- Slice 4d-1: posts / media / moderation -----------------------------------

/** posts.type CHECK: image | video */
export type PostMediaType = "image" | "video";

/** moderation_reports.reason CHECK (spec §4) */
export type ModerationReason = "spam" | "harassment" | "nudity" | "violence" | "other";

/**
 * SerializedPost (server serializePostForViewer). media_url is resolved by the
 * active storage provider (null when the key is foreign to it).
 */
export interface Post {
  id: string;
  event_id: string;
  check_in_id: string;
  user_id: string;
  spot_id: string;
  type: PostMediaType;
  caption: string | null;
  object_key: string;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  media_url: string | null;
  created_at: string;
}

/** Poster identity that rides on each feed row (spec §2f). */
export interface FeedPoster {
  id: string;
  display_name: string;
  star_rating: number;
}

/** GET /api/v1/spots/:id/feed — the spot's Live feed (newest first). */
export interface SpotFeedResponse {
  posts: Array<Post & { event: { id: string; start_at: string; status: string; going_count: number }; poster: FeedPoster }>;
  spot: Spot;
  pagination: { limit: number; offset: number; count: number };
}

export type SpotFeedRow = SpotFeedResponse["posts"][number];

/** POST /api/v1/events/:eventId/posts (201) */
export interface CreatePostResponse {
  post: Post;
}

/** POST /api/v1/posts/:postId/report (201) */
export interface ReportPostResponse {
  report: {
    id: string;
    post_id: string;
    reason: ModerationReason;
    status: "open" | "actioned" | "dismissed";
    created_at: string;
  };
}

/** POST /api/v1/media/upload-url (201) — storage contract (spec §2f). */
export interface RequestUploadUrlResponse {
  upload: {
    object_key: string;
    upload_url: string;
    method: "PUT";
    headers: Record<string, string>;
    expires_at: string;
  };
}
