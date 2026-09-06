import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool";
import {
  findEventById, findSpotById, findUserById, getGoingRow, serializeEventForViewer, serializeSpotRaw,
  type GoingRow,
} from "../db";
import { SHARE_LIMIT_PER_DAY, shareBudgetRemaining } from "../lib/limits";
import { badRequest, conflict, notFound, rateLimited } from "../lib/errors";

// Spec §2b: future dates capped at 14 days out (Open Decision 9: recommended).
const MAX_DAYS_AHEAD = 14;
const MIN_START_DELTA_MINUTES = 30; // don't announce an event already past its window

export const announceEventSchema = z.object({
  spot_id: z.string().uuid(),
  start_at: z.string().datetime({ offset: true }), // ISO 8601 with offset/Z
  note: z.string().max(140).optional(),
});


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

  // --- cancel my Going -------------------------------------------------------
  // NOTE (Slice 3): the real handler lives in src/routes/checkins.ts, which
  // registers DELETE /api/v1/events/:id/going with ledger-backed settlement
  // (free_cancel ≥ 2 h, soft_no_show < 2 h). This file must NOT register the
  // same route twice — checkins.ts owns it.

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
  // Returns the masked spot card PLUS the spot-detail fields a client needs
  // in one round-trip: the next upcoming active event (start time), the live
  // going count on it, and the viewer's own going state (drives the "I'm
  // going" toggle + address-unmask for confirmed custom spots).
  app.get("/api/v1/spots/:id", async (req) => {
    const { id } = req.params as { id: string };
    const spot = await findSpotById(pool, id);
    if (!spot) throw notFound("spot not found");
    const viewerId = req.userClaims?.sub ?? null;
    const isCreator = viewerId !== null && spot.created_by === viewerId;
    const { rows: nextRows } = await pool.query<{
      id: string; start_at: string; default_end: string; note: string | null; status: string;
    }>(
      `SELECT id, start_at, default_end, note, status FROM events
       WHERE spot_id = $1 AND status = 'active' AND default_end > now()
       ORDER BY start_at ASC LIMIT 1`,
      [id],
    );
    const next = nextRows[0] ?? null;
    let goingCount = 0;
    let myGoing = false;
    if (next) {
      const { rows: c } = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM going WHERE event_id = $1 AND status = 'active'",
        [next.id],
      );
      goingCount = c[0]?.n ?? 0;
      if (viewerId) {
        const g = await getGoingRow(pool, next.id, viewerId);
        myGoing = g?.status === "active";
      }
    }
    const confirmed = isCreator || myGoing;
    return {
      spot: serializeSpotRaw(spot, { confirmed }),
      next_event: next
        ? { id: next.id, start_at: next.start_at, default_end: next.default_end, note: next.note, status: next.status }
        : null,
      going_count: goingCount,
      my_going: myGoing,
    };
  });

  // --- shareable snapshot for a spot's share card (§2g) ---------------------
  // GET /api/v1/spots/:id/share — the server-rendered fields the client bakes
  // into the one-tap share card (spot name, masked/verified address per
  // viewer, next event start, going count, creator display name), plus the
  // live share budget. Same strict 10/day gate as POST /api/v1/shares
  // (shared budget helper): an authenticated viewer with no budget left gets
  // 429 rate_limited, so the client knows to disable the Share button.
  app.get("/api/v1/spots/:id/share", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw notFound("spot not found");
    }
    const viewerId = req.userClaims?.sub ?? null;
    if (viewerId) {
      const { remaining } = await shareBudgetRemaining(pool, viewerId);
      if (remaining <= 0) {
        throw rateLimited(`share limit reached (${SHARE_LIMIT_PER_DAY}/day)`);
      }
    }
    const spot = await findSpotById(pool, id);
    if (!spot) throw notFound("spot not found");
    const isCreator = viewerId !== null && spot.created_by === viewerId;
    const { rows: nextRows } = await pool.query<{ id: string; start_at: string }>(
      `SELECT id, start_at FROM events
       WHERE spot_id = $1 AND status = 'active' AND default_end > now()
       ORDER BY start_at ASC LIMIT 1`,
      [id],
    );
    const next = nextRows[0] ?? null;
    let goingCount = 0;
    let myGoing = false;
    if (next) {
      const { rows: c } = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM going WHERE event_id = $1 AND status = 'active'",
        [next.id],
      );
      goingCount = c[0]?.n ?? 0;
      if (viewerId) {
        const g = await getGoingRow(pool, next.id, viewerId);
        myGoing = g?.status === "active";
      }
    }
    const confirmed = isCreator || myGoing;
    const card = serializeSpotRaw(spot, { confirmed });
    let creatorName: string | null = null;
    if (spot.created_by) {
      const creator = await findUserById(pool, spot.created_by);
      creatorName = creator?.display_name ?? null;
    }
    let remaining: number | null = null;
    if (viewerId) {
      remaining = (await shareBudgetRemaining(pool, viewerId)).remaining;
    }
    return reply.send({
      card: {
        spot_name: card.name,
        category: card.category,
        address: card.address,
        masked_address: card.masked_address,
        is_verified: card.is_verified,
        city: card.city,
        next_start_at: next?.start_at ?? null,
        going_count: goingCount,
        creator_display_name: creatorName,
      },
      share: {
        limit: SHARE_LIMIT_PER_DAY,
        remaining,
        deep_link: `https://imgoing.io/s/${spot.id}`,
      },
    });
  });

  // --- my going history (spec §3.5 My Plans) -------------------------------
  // GET /api/v1/me/going — the viewer's Going rows: `upcoming` (active rows on
  // events that haven't ended yet, soonest first) and `recent` (rows on
  // already-ended events from the last 7 days, with settlement outcomes —
  // the "yesterday's outcome" line: showup / no_show / soft_no_show /
  // free_cancel / unverifiable / pending when settlement hasn't run yet).
  app.get("/api/v1/me/going", {
    preHandler: app.authenticate,
  }, async (req) => {
    const userId = req.userClaims!.sub;
    const { rows: upcoming } = await pool.query<{
      event: Record<string, unknown>;
      settlement_kind: string | null;
      settled_at: string | null;
    }>(
      `SELECT json_build_object(
         'id', e.id, 'spot_id', e.spot_id, 'start_at', e.start_at,
         'default_end', e.default_end, 'note', e.note, 'status', e.status,
         'created_by', e.created_by, 'created_at', e.created_at
       ) AS event,
       g.settlement_kind, g.settled_at
       FROM going g JOIN events e ON e.id = g.event_id
       WHERE g.user_id = $1 AND g.status = 'active' AND e.default_end > now()
       ORDER BY e.start_at ASC LIMIT 50`,
      [userId],
    );
    const { rows: recent } = await pool.query<{
      event: Record<string, unknown>;
      settlement_kind: string | null;
      settled_at: string | null;
    }>(
      `SELECT json_build_object(
         'id', e.id, 'spot_id', e.spot_id, 'start_at', e.start_at,
         'default_end', e.default_end, 'note', e.note, 'status', e.status,
         'created_by', e.created_by, 'created_at', e.created_at
       ) AS event,
       g.settlement_kind, g.settled_at
       FROM going g JOIN events e ON e.id = g.event_id
       WHERE g.user_id = $1 AND e.default_end <= now()
         AND e.default_end > now() - interval '7 days'
       ORDER BY e.start_at DESC LIMIT 20`,
      [userId],
    );
    // Attach the masked spot card to each row (creator sees their pin).
    async function withSpot(
      rows: { event: Record<string, unknown>; settlement_kind: string | null; settled_at: string | null }[],
    ): Promise<Array<{ event: Record<string, unknown>; spot: unknown; settlement_kind: string | null; settled_at: string | null }>> {
      return Promise.all(rows.map(async (r) => {
        const eventId = r.event.id as string;
        const spotId = r.event.spot_id as string;
        const spot = await findSpotById(pool, spotId);
        const eventRow = await findEventById(pool, eventId);
        const goingRow = (await getGoingRow(pool, eventId, userId)) as GoingRow | undefined;
        const confirmed = goingRow?.status === "active" || (spot?.created_by === userId);
        return {
          event: r.event,
          spot: spot ? serializeSpotRaw(spot, { confirmed }) : null,
          my_going: goingRow?.status === "active",
          start_at: r.event.start_at,
          settlement_kind: r.settlement_kind,
          settled_at: r.settled_at,
          // Cancel affordance per spec §2e: free while ≥ 2 h before start.
          free_cancel_until: eventRow
            ? new Date(new Date(eventRow.start_at).getTime() - 2 * 3_600_000).toISOString()
            : null,
        };
      }));
    }
    return { upcoming: await withSpot(upcoming), recent: await withSpot(recent) };
  });
}