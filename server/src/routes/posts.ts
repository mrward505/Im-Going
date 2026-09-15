import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool";
import { serializePostForViewer, serializeSpotRaw, type PostRow, type FeedRow } from "../db";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { getStorage, isAvatarContentType } from "../lib/storage";

// Spec §2f: post body — image or ≤10 s video, 140-char caption, the object key
// the client received from the storage contract (requestUploadUrl → PUT → key).
const createPostSchema = z.object({
  type: z.enum(["image", "video"]),
  caption: z.string().max(140).optional(),
  object_key: z.string().min(1).max(512),
  width: z.number().int().min(1).max(20_000).optional(),
  height: z.number().int().min(1).max(20_000).optional(),
  duration_s: z.number().int().min(0).max(600).optional(),
});

const feedQuerySchema = z.object({
  // Raw bounds; the handler clamps limit to the 50 cap (friendlier than 400).
  limit: z.coerce.number().int().min(1).max(10_000).default(20),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
const FEED_LIMIT_CAP = 50;

const paramsSchema = z.object({ id: z.string().uuid() });

// Moderation reasons mirror the DB CHECK (001_initial_schema.sql).
const REPORT_REASONS = ["spam", "harassment", "nudity", "violence", "other"] as const;
const reportSchema = z.object({ reason: z.enum(REPORT_REASONS) });

const uploadUrlSchema = z.object({
  content_type: z.enum(["image/jpeg", "image/png", "image/heic", "video/mp4", "video/quicktime"]),
  ext: z.string().regex(/^[a-z0-9]{2,5}$/).optional(),
  kind: z.enum(["post", "avatar"]).optional(),
});

export async function registerPostRoutes(app: FastifyInstance): Promise<void> {
  const pool = getPool();

  // Binary bodies for the local provider's PUT (images/videos). Scoped regex:
  // application/json parsing everywhere else is untouched.
  app.addContentTypeParser(/^(image|video)\//, { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  // --- create a media post (check-in-gated, spec §2f hard rule) -------------
  app.post("/api/v1/events/:id/posts", {
    preHandler: app.authenticate,
  }, async (req, reply) => {
    const claims = req.userClaims!;
    const { id } = paramsSchema.parse(req.params);
    const input = createPostSchema.parse(req.body);

    const event = (await pool.query<{ id: string; spot_id: string }>(
      "SELECT id, spot_id FROM events WHERE id = $1",
      [id],
    )).rows[0];
    if (!event) throw notFound("event not found");

    // THE hard rule: the poster must hold a verified check-in at this event
    // (checkins row for user+event). No check-in, no post (spec §2f).
    const checkin = (await pool.query<{ id: string }>(
      "SELECT id FROM checkins WHERE event_id = $1 AND user_id = $2",
      [id, claims.sub],
    )).rows[0];
    if (!checkin) throw forbidden("must check in before posting");

    // object_key must resolve on the active storage provider (defends against
    // junk keys and makes the storage contract the single source of truth).
    const storage = getStorage();
    if (!storage.getPublicUrl(input.object_key)) {
      throw badRequest("unknown object_key — request an upload URL first");
    }

    // One post per check-in via UNIQUE(check_in_id) — surface a clean 409.
    try {
      const inserted = await pool.query<PostRow>(
        `INSERT INTO posts (event_id, check_in_id, user_id, spot_id, type, caption, object_key, width, height, duration_s)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [
          id, checkin.id, claims.sub, event.spot_id,
          input.type, input.caption ?? null, input.object_key,
          input.width ?? null, input.height ?? null, input.duration_s ?? null,
        ],
      );
      const post = inserted.rows[0];
      return reply.code(201).send({
        post: serializePostForViewer(post, { media_url: storage.getPublicUrl(post.object_key) }),
      });
    } catch (err) {
      const pgCode = (err as { code?: string })?.code;
      if (pgCode === "23505") {
        // UNIQUE(check_in_id) violation → the poster already posted from this check-in.
        const dupe = (await pool.query<{ id: string }>(
          "SELECT id FROM posts WHERE check_in_id = $1",
          [checkin.id],
        )).rows[0];
        if (dupe) throw conflict("already posted from this check-in");
      }
      if (pgCode === "23514") {
        throw badRequest("post violates a constraint (check caption length / type)");
      }
      throw err;
    }
  });

  // --- spot Live feed (spec §2f): newest-first posts for the spot -----------
  app.get("/api/v1/spots/:id/feed", async (req) => {
    const { id } = paramsSchema.parse(req.params);
    const raw = feedQuerySchema.parse(req.query);
    const q = { limit: Math.min(raw.limit, FEED_LIMIT_CAP), offset: raw.offset };
    const spot = (await pool.query<{ id: string; is_verified: boolean }>(
      "SELECT id, is_verified FROM spots WHERE id = $1",
      [id],
    )).rows[0];
    if (!spot) throw notFound("spot not found");

    const viewerId = req.userClaims?.sub ?? null;
    // For custom (unverified) spots the address mask unlocks only for viewers
    // who hold an active Going on any of the spot's events (or created it) —
    // same rule as the spot-detail route.
    let confirmed = false;
    if (viewerId && !spot.is_verified) {
      const { rows } = await pool.query<{ n: number; created: number }>(
        `SELECT
           (SELECT count(*)::int FROM going g JOIN events e ON e.id = g.event_id
             WHERE e.spot_id = $1 AND g.user_id = $2 AND g.status = 'active') AS n,
           (SELECT count(*)::int FROM spots WHERE id = $1 AND created_by = $2) AS created`,
        [id, viewerId],
      );
      confirmed = (rows[0]?.n ?? 0) > 0 || (rows[0]?.created ?? 0) > 0;
    }

    const { rows } = await pool.query<FeedRow>(
      `SELECT p.id, p.event_id, p.check_in_id, p.user_id, p.spot_id, p.type, p.caption,
              p.object_key, p.width, p.height, p.duration_s, p.created_at,
              json_build_object('id', e.id, 'start_at', e.start_at, 'status', e.status,
                'going_count', (SELECT count(*)::int FROM going g2
                                WHERE g2.event_id = e.id AND g2.status = 'active')) AS event,
              json_build_object('id', u.id, 'display_name', u.display_name,
                'star_rating', u.star_rating, 'avatar_url', u.avatar_url) AS poster,
              s.is_verified AS spot_is_verified
       FROM posts p
       JOIN events e ON e.id = p.event_id
       JOIN users u ON u.id = p.user_id
       JOIN spots s ON s.id = p.spot_id
       WHERE p.spot_id = $1
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $2 OFFSET $3`,
      [id, q.limit, q.offset],
    );
    const storage = getStorage();
    return {
      posts: rows.map((row) => ({
        ...serializePostForViewer(row, { media_url: storage.getPublicUrl(row.object_key) }),
        // Feed-specific joins (spec §2f): the event each post belongs to and
        // the poster's display identity ride on every row.
        event: row.event,
        poster: row.poster,
      })),
      spot: serializeSpotRaw(
        (await pool.query(
          "SELECT id, name, address, lat, lon, geofence_radius_m, category, is_verified, is_large_venue, city, created_by, created_at FROM spots WHERE id = $1",
          [id],
        )).rows[0],
        { confirmed },
      ),
      pagination: { limit: q.limit, offset: q.offset, count: rows.length },
    };
  });

  // --- storage contract: request an upload slot (auth) ----------------------
  // POST /api/v1/media/upload-url — the client calls this first, PUTs the bytes
  // to upload_url with headers, then POSTs the post with the returned
  // object_key. Same provider serves both, so local dev is a closed loop.
  app.post("/api/v1/media/upload-url", {
    preHandler: app.authenticate,
  }, async (req, reply) => {
    const claims = req.userClaims!;
    const body = uploadUrlSchema.parse(req.body);
    // REVAMP 5: avatar slots are pictures only — a profile picture can never be
    // a video, and the key lands in the caller's own avatars/ namespace.
    if (body.kind === "avatar" && !isAvatarContentType(body.content_type)) {
      throw badRequest("profile pictures must be image/jpeg, image/png or image/heic");
    }
    const upload = await getStorage().requestUploadUrl(body, claims.sub);
    return reply.code(201).send({ upload });
  });

  // --- local provider: accept bytes (dev only; cloud providers take direct PUTs)
  app.put("/api/v1/media/upload/:p0/:p1/:p2", async (req, reply) => {
    const key = ["p0", "p1", "p2"].map((p) => (req.params as Record<string, string>)[p]).join("/");
    const storage = getStorage();
    if (!storage.putObject) throw notFound("no local storage provider");
    const contentType = String(req.headers["content-type"] ?? "application/octet-stream");
    const bytes = new Uint8Array(req.body as Buffer);
    storage.putObject(key, bytes, contentType);
    return reply.code(201).send({ object_key: key, size: bytes.byteLength });
  });

  // --- local provider: serve bytes ------------------------------------------
  app.get("/api/v1/media/*", async (req, reply) => {
    const key = (req.params as { "*": string })["*"];
    const storage = getStorage();
    const obj = storage.getObject?.(key);
    if (!obj) throw notFound("media not found");
    return reply
      .header("content-type", obj.contentType)
      .header("cache-control", "public, max-age=31536000, immutable")
      .send(obj.bytes);
  });

  // --- my own posts (REVAMP 5): the profile photo grid ----------------------
  // GET /api/v1/me/posts — every real post the viewer published from a
  // verified check-in, newest first. The profile renders these as the
  // IG-style grid next to the imported posts. No invented rows: an empty
  // profile returns an empty list.
  app.get("/api/v1/me/posts", {
    preHandler: app.authenticate,
  }, async (req) => {
    const claims = req.userClaims!;
    const raw = feedQuerySchema.parse(req.query);
    const q = { limit: Math.min(raw.limit, FEED_LIMIT_CAP), offset: raw.offset };
    const { rows } = await pool.query<{
      id: string; event_id: string; spot_id: string; type: string; caption: string | null;
      object_key: string; width: number | null; height: number | null; duration_s: number | null;
      created_at: string; spot_name: string; spot_city: string; spot_is_verified: boolean;
    }>(
      `SELECT p.id, p.event_id, p.spot_id, p.type, p.caption, p.object_key, p.width, p.height,
              p.duration_s, p.created_at,
              s.name AS spot_name, s.city AS spot_city, s.is_verified AS spot_is_verified
       FROM posts p JOIN spots s ON s.id = p.spot_id
       WHERE p.user_id = $1
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT $2 OFFSET $3`,
      [claims.sub, q.limit, q.offset],
    );
    const storage = getStorage();
    return {
      posts: rows.map((row) => ({
        id: row.id,
        event_id: row.event_id,
        spot_id: row.spot_id,
        type: row.type === "video" ? "video" : "image",
        caption: row.caption,
        media_url: storage.getPublicUrl(row.object_key),
        width: row.width,
        height: row.height,
        duration_s: row.duration_s,
        created_at: row.created_at,
        spot: { id: row.spot_id, name: row.spot_name, city: row.spot_city, is_verified: row.spot_is_verified },
      })),
      pagination: { limit: q.limit, offset: q.offset, count: rows.length },
    };
  });

  // --- moderation report (spec §2f/§4 ModerationReport) ----------------------
  app.post("/api/v1/posts/:id/report", {
    preHandler: app.authenticate,
  }, async (req, reply) => {
    const claims = req.userClaims!;
    const { id } = paramsSchema.parse(req.params);
    const { reason } = reportSchema.parse(req.body);
    const post = (await pool.query<{ id: string }>("SELECT id FROM posts WHERE id = $1", [id])).rows[0];
    if (!post) throw notFound("post not found");
    try {
      const { rows } = await pool.query<{ id: string; post_id: string; reason: string; status: string; created_at: string }>(
        `INSERT INTO moderation_reports (reporter_id, post_id, reason) VALUES ($1, $2, $3)
         RETURNING id, post_id, reason, status, created_at`,
        [claims.sub, id, reason],
      );
      const r = rows[0];
      return reply.code(201).send({ report: { id: r.id, post_id: r.post_id, reason: r.reason, status: r.status, created_at: r.created_at } });
    } catch (err) {
      const pgCode = (err as { code?: string })?.code;
      if (pgCode === "23505") {
        throw conflict("you already reported this post");
      }
      throw err;
    }
  });
}
