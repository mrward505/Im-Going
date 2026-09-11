/**
 * REVAMP 3 — "Bring your nights" social import (owner directive 2026-09-09).
 *
 * A user imports up to 3 public posts from IG/X/TikTok, each attached to ONE
 * real spot they have actually been to, so followers see the kind of nights
 * they're into. Honesty rules:
 *   - No fabricated content: provenance (platform + source_url) is required
 *     and stored; the server never fetches or invents the post's media.
 *   - IG/TikTok/X all restrict third-party fetching (their oEmbed/API paths
 *     require platform approval or auth). The honest path is therefore: the
 *     user pastes their PUBLIC post URL (provenance) — and, when they want a
 *     visual, uploads a screenshot/photo THEY own via the existing media
 *     contract (object_key) or pastes a media URL they already host. The
 *     server stores exactly what the user provides. Nothing is auto-asserted.
 *   - Been-there gate: either (a) a REAL verified check-in at that spot
 *     (been_there_kind = 'checkin', referencing the checkins row) or
 *     (b) an explicit user claim (been_there_kind = 'claim', claim_status
 *     'pending' until the trust engine verifies). The API NEVER invents a
 *     check-in for the user.
 *   - Hard cap: 3 imported posts per user (API + DB trigger).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool";
import { findSpotById, serializeImportedPost, type ImportedPostRow } from "../db";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { getStorage } from "../lib/storage";

export const IMPORT_LIMIT = 3;
/** An import stays "recent" for 30 days after it is added (derived signal). */
export const RECENT_WINDOW_DAYS = 30;

const PLATFORMS = ["instagram", "x", "tiktok", "other"] as const;
export type ImportPlatform = (typeof PLATFORMS)[number];

const createImportSchema = z.object({
  platform: z.enum(PLATFORMS),
  /** Public URL of the user's own post on the other platform (provenance). */
  source_url: z.string().url().max(2048),
  spot_id: z.string().uuid(),
  caption: z.string().trim().max(140).optional(),
  /** External URL of media the user owns/hosts (their screenshot on their CDN). */
  media_url: z.string().url().max(2048).optional(),
  /** OR: a key minted by the media upload contract (upload-url → PUT). */
  object_key: z.string().min(1).max(512).optional(),
  /** Explicit been-there basis. Omitted → auto use a real check-in when one exists. */
  been_there: z.enum(["checkin", "claim"]).optional(),
  /** Optional corroborating words for a claim (stored for the trust engine). */
  claim: z.string().trim().max(140).optional(),
});

const paramsSchema = z.object({ id: z.string().uuid() });

export async function registerImportRoutes(app: FastifyInstance): Promise<void> {
  const pool = getPool();

  // --- list my imports (auth) -------------------------------------------------
  app.get("/api/v1/me/imports", { preHandler: app.authenticate }, async (req) => {
    const claims = req.userClaims!;
    const { rows } = await pool.query<ImportedPostRow>(
      `SELECT i.id, i.user_id, i.spot_id, i.platform, i.source_url, i.media_url,
              i.caption, i.been_there_kind, i.check_in_id, i.claim_status, i.created_at
       FROM imported_posts i
       WHERE i.user_id = $1
       ORDER BY i.created_at DESC, i.id DESC`,
      [claims.sub],
    );
    // Owner views their own imports → custom-spot pins/addresses are confirmed.
    const imports = await Promise.all(
      rows.map(async (row) => {
        const spot = await findSpotById(pool, row.spot_id);
        return serializeImportedPost(row, spot ?? null, { confirmed: true });
      }),
    );
    return {
      imports,
      limit: IMPORT_LIMIT,
      remaining: Math.max(0, IMPORT_LIMIT - imports.length),
    };
  });

  // --- create an import (auth, capped at 3) -----------------------------------
  app.post("/api/v1/me/imports", { preHandler: app.authenticate }, async (req, reply) => {
    const claims = req.userClaims!;
    const input = createImportSchema.parse(req.body);

    const spot = await findSpotById(pool, input.spot_id);
    if (!spot) throw notFound("spot not found");

    // Media: at most one of {media_url, object_key}; object_key must resolve on
    // the active storage provider (same contract as posts).
    if (input.media_url !== undefined && input.object_key !== undefined) {
      throw badRequest("provide either media_url or object_key, not both");
    }
    let mediaUrl: string | null = input.media_url ?? null;
    if (input.object_key !== undefined) {
      const storage = getStorage();
      const resolved = storage.getPublicUrl(input.object_key);
      if (!resolved) throw badRequest("unknown object_key — request an upload URL first");
      // Honest media contract: the media_url must resolve to media the user
      // actually uploaded. The local provider can read bytes back, so a
      // minted-but-never-uploaded key is rejected here (never a dead link).
      // Providers without a read-back (future cloud slots) fall back to the
      // shape-only gate, matching posts.ts.
      const existing = storage.getObject?.(input.object_key);
      if (existing === null) {
        throw badRequest("object_key has no uploaded media — PUT the bytes first");
      }
      mediaUrl = resolved;
    }

    // The been-there gate — never auto-assert a check-in that didn't happen.
    let kind: "checkin" | "claim";
    let checkInId: string | null = null;
    let claimStatus: "verified" | "pending" = "pending";
    if (input.been_there === "claim") {
      kind = "claim";
    } else {
      // 'checkin' requested OR omitted → look for a REAL verified check-in.
      const checkin = (await pool.query<{ id: string }>(
        "SELECT id FROM checkins WHERE user_id = $1 AND spot_id = $2 ORDER BY verified_at DESC LIMIT 1",
        [claims.sub, input.spot_id],
      )).rows[0];
      if (checkin) {
        kind = "checkin";
        checkInId = checkin.id;
        claimStatus = "verified";
      } else if (input.been_there === "checkin") {
        throw badRequest(
          "you have no verified check-in at that spot — pass been_there:'claim' to explicitly claim you've been there",
        );
      } else {
        throw badRequest(
          "attach a verified check-in or explicitly claim you've been there (been_there:'claim')",
        );
      }
    }

    // Cap check inside a transaction that locks the user row (serializes
    // concurrent imports); the DB trigger is the airtight backstop.
    const client = await pool.connect();
    let inserted: ImportedPostRow | undefined;
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [claims.sub]);
      const { rows } = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM imported_posts WHERE user_id = $1",
        [claims.sub],
      );
      const remaining = IMPORT_LIMIT - (rows[0]?.n ?? 0);
      if (remaining <= 0) throw conflict(`import limit reached (${IMPORT_LIMIT} max)`);
      const created = await client.query<ImportedPostRow>(
        `INSERT INTO imported_posts
           (user_id, spot_id, platform, source_url, media_url, caption,
            been_there_kind, check_in_id, claim_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, user_id, spot_id, platform, source_url, media_url,
                   caption, been_there_kind, check_in_id, claim_status, created_at`,
        [
          claims.sub, input.spot_id, input.platform, input.source_url,
          mediaUrl, input.caption ?? null, kind, checkInId, claimStatus,
        ],
      );
      inserted = created.rows[0];
      await client.query("COMMIT");
      return reply.code(201).send({
        imported: serializeImportedPost(inserted, spot, { confirmed: true }),
        limit: IMPORT_LIMIT,
        imports_remaining: remaining - 1,
      });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // already rolled back — the real error below matters
      }
      const pgCode = (err as { code?: string })?.code;
      if (pgCode === "23505") {
        // UNIQUE(user_id, source_url) or the cap trigger (23514) races
        throw conflict("that post is already imported");
      }
      if (pgCode === "23514") {
        throw conflict(`import limit reached (${IMPORT_LIMIT} max)`);
      }
      if (err instanceof Error && err.message.includes("import cap exceeded")) {
        throw conflict(`import limit reached (${IMPORT_LIMIT} max)`);
      }
      throw err;
    } finally {
      client.release();
    }
  });

  // --- remove an import (auth, own rows only) ---------------------------------
  app.delete("/api/v1/me/imports/:id", { preHandler: app.authenticate }, async (req) => {
    const claims = req.userClaims!;
    const { id } = paramsSchema.parse(req.params);
    const row = (await pool.query<{ id: string; user_id: string }>(
      "SELECT id, user_id FROM imported_posts WHERE id = $1",
      [id],
    )).rows[0];
    if (!row) throw notFound("import not found");
    if (row.user_id !== claims.sub) throw forbidden("not your import");
    await pool.query("DELETE FROM imported_posts WHERE id = $1", [id]);
    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM imported_posts WHERE user_id = $1",
      [claims.sub],
    );
    return { id, imports_remaining: IMPORT_LIMIT - (rows[0]?.n ?? 0), limit: IMPORT_LIMIT };
  });
}