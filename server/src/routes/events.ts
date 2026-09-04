import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool";
import {
  findEventById, findSpotById, getGoingRow, serializeEventForViewer, serializeSpotRaw,
} from "../db";
import { badRequest, conflict, notFound } from "../lib/errors";
import { FREE_CANCEL_DELTA, SOFT_NO_SHOW_DELTA, UNVERIFIABLE_DELTA } from "../lib/reputation";
import { getConfig } from "../env";

// Spec §2b: future dates capped at 14 days out (Open Decision 9: recommended).
const MAX_DAYS_AHEAD = 14;
const MIN_START_DELTA_MINUTES = 30; // don't announce an event already past its window

export const announceEventSchema = z.object({
  spot_id: z.string().uuid(),
  start_at: z.string().datetime({ offset: true }), // ISO 8601 with offset/Z
  note: z.string().max(140).optional(),
});

const goingParamsSchema = z.object({ id: z.string().uuid() });

/** Resolve the shared Event for (spot, upcoming start): snap to the earliest
 *  active event on that spot starting within the same UTC day, else create. */
async function resolveOrCreateEvent(
  pool: ReturnType<typeof getPool>,
  spotId: string,
  startAt: Date,
  note: string | null,
  userId: string,
): Promise<{ id: string; snapped: boolean }> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM events
     WHERE spot_id = $1 AND status = 'active'
       AND start_at >= date_trunc('day', $2::timestamptz)
       AND start_at < date_trunc('day', $2::timestamptz) + interval '1 day'
     ORDER BY start_at ASC LIMIT 1`,
    [spotId, startAt],
  );
  if (rows[0]) return { id: rows[0].id, snapped: true };
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO events (spot_id, start_at, note, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [spotId, startAt, note, userId],
  );
  return { id: inserted.rows[0].id, snapped: false };
}

export async function registerEventRoutes(app: FastifyInstance): Promise<void> {
  const pool = getPool();

  // --- announce "I'm going" → Event + own Going row ----------------------
  app.post("/api/v1/events", {
    preHandler: app.authenticate,
  }, async (req, reply) => {
    const claims = req.userClaims!;
    const input = announceEventSchema.parse(req.body);
    const spot = await findSpotById(pool, input.spot_id);
    if (!spot) throw notFound("spot not found");

    const startAt = new Date(input.start_at);
    const now = new Date();
    if (startAt.getTime() < now.getTime() + MIN_START_DELTA_MINUTES * 60_000) {
      throw badRequest("start_at must be in the future (at least 30 minutes out)");
    }
    if (startAt.getTime() > now.getTime() + MAX_DAYS_AHEAD * 86_400_000) {
      throw badRequest(`start_at must be within ${MAX_DAYS_AHEAD} days`);
    }

    const { id, snapped } = await resolveOrCreateEvent(pool, spot.id, startAt, input.note ?? null, claims.sub);
    const existing = await getGoingRow(pool, id, claims.sub);
    if (existing?.status === "active") throw conflict("you already announced going to this event");

    // Insert Going (upsert semantics: if a cancelled row exists, flip it back to active).
    await pool.query(
      `INSERT INTO going (event_id, user_id, status) VALUES ($1, $2, 'active')
       ON CONFLICT (event_id, user_id)
       DO UPDATE SET status = 'active', created_at = now()`,
      [id, claims.sub],
    );

    const event = await findEventById(pool, id);
    if (!event) throw new Error("event vanished after insert");
    const spotRow = (await findSpotById(pool, spot.id))!;
    const view = await serializeEventForViewer(pool, event, spotRow, claims.sub);
    return reply.code(201).send({
      event: view,
      snapped_to_existing: snapped,
      shares_remaining: 10, // share counter enforcement lands in Slice 3
    });
  });

  // --- confirm "I'm going" on an existing event --------------------------
  app.post("/api/v1/events/:id/going", {
    preHandler: app.authenticate,
  }, async (req, reply) => {
    const claims = req.userClaims!;
    const { id } = req.params as { id: string };
    const event = await findEventById(pool, id);
    if (!event) throw notFound("event not found");
    if (event.status !== "active") throw conflict("event is cancelled");

    const existing = await getGoingRow(pool, id, claims.sub);
    if (existing?.status === "active") throw conflict("you already confirmed going to this event");

    await pool.query(
      `INSERT INTO going (event_id, user_id, status) VALUES ($1, $2, 'active')
       ON CONFLICT (event_id, user_id) DO UPDATE SET status = 'active', created_at = now()`,
      [id, claims.sub],
    );
    const spot = (await findSpotById(pool, event.spot_id))!;
    const view = await serializeEventForViewer(pool, event, spot, claims.sub);
    return reply.code(201).send({ event: view });
  });

  // --- cancel my Going (free ≥ 2h before start; soft no-show otherwise) ---
  app.delete("/api/v1/events/:id/going", {
    preHandler: app.authenticate,
  }, async (req, reply) => {
    const claims = req.userClaims!;
    const { id } = req.params as { id: string };
    const event = await findEventById(pool, id);
    if (!event) throw notFound("event not found");
    const spot = (await findSpotById(pool, event.spot_id))!;

    const going = await getGoingRow(pool, id, claims.sub);
    if (!going || going.status !== "active") throw conflict("you have no active going on this event");

    await pool.query(`UPDATE going SET status = 'cancelled' WHERE id = $1`, [going.id]);

    // Settlement semantics (spec §2e). Slice 3 writes the actual ledger rows
    // + user cache; until then we report the outcome without mutating points.
    const hoursBefore = (new Date(event.start_at).getTime() - Date.now()) / 3_600_000;
    let settlement: "free_cancel" | "soft_no_show" | "unverifiable" = "unverifiable";
    let delta = UNVERIFIABLE_DELTA;
    if (hoursBefore >= 2) {
      settlement = "free_cancel";
      delta = FREE_CANCEL_DELTA;
    } else if (hoursBefore >= 0) {
      settlement = "soft_no_show"; // < 2h: soft no-show (−30)
      delta = SOFT_NO_SHOW_DELTA;
    }
    // If the event window already elapsed with no check-in and location was
    // granted (the no-show path), settlement = "no_show" is decided here at
    // Slice 3 (repuation_ledger not yet written by this endpoint).

    const view = await serializeEventForViewer(pool, event, spot, claims.sub);
    return reply.send({ event: view, settlement, points_delta_report_only: delta });
  });

  // --- event detail (custom spot mask unlocks only for confirmers) --------
  app.get("/api/v1/events/:id", async (req) => {
    const { id } = req.params as { id: string };
    const event = await findEventById(pool, id);
    if (!event) throw notFound("event not found");
    const spot = (await findSpotById(pool, event.spot_id))!;
    const viewerId = req.userClaims?.sub ?? null;
    const view = await serializeEventForViewer(pool, event, spot, viewerId);
    return { event: view };
  });

  // --- fetch a single spot by id (masking logic shared with search) -------
  app.get("/api/v1/spots/:id", async (req) => {
    const { id } = req.params as { id: string };
    const spot = await findSpotById(pool, id);
    if (!spot) throw notFound("spot not found");
    const viewerId = req.userClaims?.sub ?? null;
    const isCreator = viewerId !== null && spot.created_by === viewerId;
    return { spot: serializeSpotRaw(spot, { confirmed: isCreator }) };
  });
}