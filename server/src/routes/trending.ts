import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool";
import { spotTrending, TRENDING_LIMIT } from "../lib/trending";
import { spotAudience } from "../lib/audience";
import { serializeSpotRaw, findSpotById } from "../db";
import { SHARE_LIMIT_PER_DAY, consumeShare, shareBudgetRemaining } from "../lib/limits";

/**
 * GET /api/v1/trending — top-20 spots with events starting in the next 48 h
 * (spec §2c). Scores come from src/lib/trending.ts (shared with unit tests);
 * this route wires it to HTTP and attaches spot cards with the custom-spot
 * masking rule (§2b: private spots mask address/pin until the viewer confirms).
 *
 * Slice 4d-3c: each row also carries the live-audience snapshot (going_now,
 * heat_count, heat_level) from lib/audience.ts — the same real-data signals
 * spot detail + share payloads carry, so the Trending list can show heat
 * badges with no invented numbers. Additive only (no fields removed).
 */
export async function registerTrendingRoutes(app: FastifyInstance): Promise<void> {
  const pool = getPool();
  app.get("/api/v1/trending", async (req) => {
    const rows = await spotTrending(pool, { limit: TRENDING_LIMIT });
    const viewerId = req.userClaims?.sub ?? null;
    const spots = await Promise.all(rows.map(async (r) => {
      const spot = (await findSpotById(pool, r.spot_id))!;
      let confirmed = false;
      if (viewerId) {
        const { rows: g } = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM going g JOIN events e ON e.id = g.event_id
           WHERE e.spot_id = $1 AND g.user_id = $2 AND g.status = 'active'
             AND e.start_at > now() AND e.start_at <= now() + interval '48 hours'`,
          [r.spot_id, viewerId],
        );
        confirmed = (g[0]?.n ?? 0) > 0;
      }
      return {
        spot: serializeSpotRaw(spot, { confirmed }),
        next_start_at: r.next_start_at,
        going_count: r.going_count,
        trending_score: r.trending_score,
        ...(await spotAudience(pool, r.spot_id)),
      };
    }));
    return { trending: spots };
  });
}

const shareBodySchema = z.object({
  // What surface the share went through (audit only; the card itself is
  // client-rendered per §2g). Free-form but length-capped.
  channel: z.string().min(1).max(40).optional(),
  event_id: z.string().uuid().optional(),
});

/**
 * POST /api/v1/shares — register one outbound share-card share (§2g).
 * Enforces the 10-shares/day per-user limit with 429 when exceeded.
 * GET /api/v1/shares/budget — remaining shares today (for disabling the button).
 */
export async function registerShareRoutes(app: FastifyInstance): Promise<void> {
  const pool = getPool();

  app.get("/api/v1/shares/budget", {
    preHandler: app.authenticate,
  }, async (req) => {
    const claims = req.userClaims!;
    const { remaining } = await shareBudgetRemaining(pool, claims.sub);
    return { limit: SHARE_LIMIT_PER_DAY, remaining };
  });

  app.post("/api/v1/shares", {
    preHandler: app.authenticate,
  }, async (req, reply) => {
    const claims = req.userClaims!;
    shareBodySchema.parse(req.body ?? {});
    const { remaining } = await shareBudgetRemaining(pool, claims.sub);
    if (remaining <= 0) {
      return reply.code(429).send({
        error: { code: "rate_limited", message: `share limit reached (${SHARE_LIMIT_PER_DAY}/day)` },
        limit: SHARE_LIMIT_PER_DAY,
        remaining: 0,
      });
    }
    const left = await consumeShare(pool, claims.sub);
    return reply.code(201).send({ limit: SHARE_LIMIT_PER_DAY, remaining: left });
  });
}
