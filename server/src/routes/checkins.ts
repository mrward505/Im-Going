import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool";
import { findEventById, findSpotById, type SpotRow } from "../db";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import {
  eventWindow, haversineMeters, insideGeofence, isImplausibleMove, radiusFor,
} from "../lib/geofence";
import {
  cancelSettlement, settleGoing, type SettlementKind,
} from "../lib/settlement";
import {
  findSpotById as findSpotRow,
  getGoingRow as getGoingRowByIds,
  serializeEventForViewer as serializeEventView,
} from "../db";
import {
  NO_SHOW_DELTA, SHOWUP_DELTA, SOFT_NO_SHOW_DELTA,
} from "../lib/reputation";
import { CHECKIN_CAP_PER_DAY, CHECKIN_CAP_PER_WEEK } from "../lib/limits";

const checkinBodySchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  // Client-reported horizontal accuracy (m). Stored for audit; the server
  // does NOT trust it for geofence decisions beyond basic plausibility.
  accuracy_m: z.number().min(0).max(100_000).optional().default(0),
  // "manual_gps" ("I'm here" tap) is the primary path; "passive" is the
  // best-effort background path. Spec: absence of passive data never penalizes.
  method: z.enum(["manual_gps", "passive"]).default("manual_gps"),
  // Whether the client had location permission at fix time. The server trusts
  // this flag for settlement (no-show vs unverifiable); lying only forfeits
  // the user's own credit, so there is no incentive to fake it.
  location_permission_granted: z.boolean().default(true),
});

const paramsSchema = z.object({ id: z.string().uuid() });
const settleQuerySchema = z.object({ dry_run: z.coerce.boolean().default(false) });

/**
 * Pick the event's spot for a verified fix. A fix inside multiple overlapping
 * geofences assigns to the nearest spot center (spec §2e) — here that means
 * the event's own spot vs. other active spots nearby: we record the nearest
 * spot id as the denormalized checkins.spot_id.
 */
async function nearestSpotId(
  eventSpot: SpotRow,
  fix: { lat: number; lon: number },
): Promise<string> {
  const pool = getPool();
  const { rows } = await pool.query<Pick<SpotRow, "id" | "lat" | "lon" | "is_verified" | "is_large_venue" | "geofence_radius_m">>(
    `SELECT id, lat, lon, is_verified, is_large_venue, geofence_radius_m FROM spots
     WHERE city = $1 AND abs(lat - $2) < 0.05 AND abs(lon - $3) < 0.05`,
    [eventSpot.city, fix.lat, fix.lon],
  );
  let best: { id: string; d: number } | null = null;
  const candidates = [eventSpot, ...rows.filter((r) => r.id !== eventSpot.id)];
  for (const s of candidates) {
    const d = haversineMeters(s.lat, s.lon, fix.lat, fix.lon);
    if (d <= radiusFor(s) && (best === null || d < best.d)) best = { id: s.id, d };
  }
  return best?.id ?? eventSpot.id;
}

export async function registerCheckinRoutes(app: FastifyInstance): Promise<void> {
  const pool = getPool();

  // --- manual/passive check-in -------------------------------------------------
  app.post("/api/v1/events/:id/checkin", {
    preHandler: app.authenticate,
  }, async (req, reply) => {
    const claims = req.userClaims!;
    const { id } = paramsSchema.parse(req.params);
    const input = checkinBodySchema.parse(req.body);
    const now = new Date(); // server clock is authoritative (spec §2e)

    const event = await findEventById(pool, id);
    if (!event) throw notFound("event not found");
    if (event.status !== "active") throw conflict("event is cancelled");
    const spot = (await findSpotById(pool, event.spot_id))!;
    if (!spot) throw notFound("spot not found");

    // Must hold an active Going to check in (announce/confirm first).
    const going = await pool.query<{ id: string; settlement_kind: SettlementKind | null }>(
      "SELECT id, settlement_kind FROM going WHERE event_id = $1 AND user_id = $2",
      [id, claims.sub],
    );
    const goingRow = going.rows[0];
    if (!goingRow) throw forbidden("confirm \"I'm going\" before checking in");
    if (goingRow.settlement_kind) throw conflict(`going already settled as ${goingRow.settlement_kind}`);

    // One check-in per (user, event) — no double counting.
    const existing = await pool.query<{ id: string }>(
      "SELECT id FROM checkins WHERE event_id = $1 AND user_id = $2",
      [id, claims.sub],
    );
    if (existing.rows[0]) throw conflict("already checked in to this event");

    if (input.method === "passive" && !input.location_permission_granted) {
      throw badRequest("passive check-in requires location permission");
    }
    if (!input.location_permission_granted) {
      throw badRequest("check-in requires location permission — grant it to earn credit");
    }

    // Window check on the SERVER clock.
    const window = eventWindow(event.start_at);
    if (now < window.start) throw conflict("check-in opens 30 minutes before start");
    if (now > window.end) throw conflict("check-in window has closed");

    // Per-account verified check-in caps: 3/day, 10/week (spec §2e).
    const [{ rows: dayRows }, { rows: weekRows }] = await Promise.all([
      pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM checkins WHERE user_id = $1 AND verified_at >= now() - interval '1 day'",
        [claims.sub],
      ),
      pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM checkins WHERE user_id = $1 AND verified_at >= now() - interval '7 days'",
        [claims.sub],
      ),
    ]);
    if ((dayRows[0]?.n ?? 0) >= CHECKIN_CAP_PER_DAY) throw forbidden("daily check-in limit reached");
    if ((weekRows[0]?.n ?? 0) >= CHECKIN_CAP_PER_WEEK) throw forbidden("weekly check-in limit reached");

    // Spoof guard: reject fixes implying > 300 km/h vs the last accepted fix.
    const prev = await pool.query<{ lat: number; lon: number; recorded_at: string }>(
      "SELECT lat, lon, recorded_at FROM user_location_fixes WHERE user_id = $1",
      [claims.sub],
    );
    if (prev.rows[0]) {
      const p = prev.rows[0];
      if (isImplausibleMove(
        { lat: p.lat, lon: p.lon, at: new Date(p.recorded_at).getTime() },
        { lat: input.lat, lon: input.lon },
        now.getTime(),
      )) {
        throw forbidden("implausible location fix rejected");
      }
    }

    // Geofence: inside the event spot's radius (overlap → nearest center).
    if (!insideGeofence(spot, { lat: input.lat, lon: input.lon })) {
      // Still record the fix (movement history), but no verification.
      await pool.query(
        `INSERT INTO user_location_fixes (user_id, lat, lon, recorded_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, recorded_at = EXCLUDED.recorded_at`,
        [claims.sub, input.lat, input.lon, now],
      );
      await pool.query("UPDATE users SET location_permission_granted = true WHERE id = $1", [claims.sub]);
      throw forbidden("outside the event geofence");
    }

    const spotId = await nearestSpotId(spot, { lat: input.lat, lon: input.lon });
    const checkin = await pool.query<{ id: string }>(
      `INSERT INTO checkins (event_id, user_id, spot_id, verified_at, method, lat, lon, accuracy_m)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [id, claims.sub, spotId, now, input.method, input.lat, input.lon, input.accuracy_m],
    );
    await pool.query(
      `INSERT INTO user_location_fixes (user_id, lat, lon, recorded_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, recorded_at = EXCLUDED.recorded_at`,
      [claims.sub, input.lat, input.lon, now],
    );
    await pool.query(
      "UPDATE users SET location_permission_granted = true, verified_checkin_count = verified_checkin_count WHERE id = $1",
      [claims.sub],
    );

    // Settlement: verified show-up +100. First verified check-in also drops
    // a zero-point first_checkin marker (documents the new-account cap lift).
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const before = await client.query<{ verified_checkin_count: number }>(
        "SELECT verified_checkin_count FROM users WHERE id = $1",
        [claims.sub],
      );
      const wasFirst = (before.rows[0]?.verified_checkin_count ?? 0) === 0;
      const result = await settleGoing(client, goingRow.id, claims.sub, id, "showup", { bumpCheckins: true });
      if (wasFirst) {
        await client.query(
          "INSERT INTO reputation_ledger (user_id, kind, points_delta, event_id) VALUES ($1, 'first_checkin', 0, $2)",
          [claims.sub, id],
        );
      }
      await client.query("COMMIT");
      return reply.code(201).send({
        checkin_id: checkin.rows[0].id,
        verified_at: now.toISOString(),
        spot_id: spotId,
        event_id: id,
        method: input.method,
        first_verified_checkin: wasFirst,
        settlement: { kind: result.kind, points_delta: SHOWUP_DELTA, reputation_points: result.reputation_points, star_rating: result.star_rating },
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  // --- late-cancel ledger writes live here (not on DELETE /going) --------------
  // Spec: < 2 h before start → soft no-show (−30 ledger row). We write the
  // ledger via settleGoing so points, stars, and going.settlement_kind stay
  // consistent; the DELETE handler in events.ts only reports the outcome.
  app.delete("/api/v1/events/:id/going", {
    preHandler: app.authenticate,
  }, async (req, reply) => {
    const claims = req.userClaims!;
    const { id } = paramsSchema.parse(req.params);
    const event = await findEventById(pool, id);
    if (!event) throw notFound("event not found");
    const spot = (await findSpotRow(pool, event.spot_id))!;
    const going = await getGoingRowByIds(pool, id, claims.sub);
    if (!going || (going.status !== "active" && !going.settlement_kind)) {
      throw conflict("you have no active going on this event");
    }
    const active = going.status === "active";
    if (active) await pool.query(`UPDATE going SET status = 'cancelled' WHERE id = $1`, [going.id]);
    const kind = cancelSettlement(event.start_at, new Date());
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // settleGoing is idempotent: a re-cancel after settlement returns the
      // recorded outcome without double-appending.
      const result = await settleGoing(client, going.id, claims.sub, id, kind);
      await client.query("COMMIT");
      const view = await serializeEventView(pool, event, spot, claims.sub);
      return reply.send({
        event: view,
        settlement: result.kind,
        points_delta: result.points_delta,
        reputation_points: result.reputation_points,
        star_rating: result.star_rating,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  // --- settlement runner -------------------------------------------------------
  // POST /api/v1/settlement/run — settle every elapsed-window Going still
  // open (cron-style, auth required; any signed-in user may trigger it in MVP,
  // idempotent so concurrent/duplicate runs are safe).
  // POST /api/v1/events/:id/settle — on-demand settlement for one event
  // after its window ends. ?dry_run=true reports without writing.
  async function settleEvent(eventId: string, now: Date, dryRun: boolean): Promise<{
    event_id: string;
    settled: { user_id: string; kind: SettlementKind; points_delta: number }[];
  }> {
    const event = await findEventById(pool, eventId);
    if (!event) throw notFound("event not found");
    const window = eventWindow(event.start_at);
    if (now <= window.end) throw conflict("event window has not ended yet");
    const { rows } = await pool.query<{
      going_id: string; user_id: string; location_permission_granted: boolean;
      checked_in: boolean; settlement_kind: SettlementKind | null;
    }>(
      `SELECT g.id AS going_id, g.user_id, u.location_permission_granted,
              EXISTS (SELECT 1 FROM checkins c WHERE c.event_id = g.event_id AND c.user_id = g.user_id) AS checked_in,
              g.settlement_kind
       FROM going g JOIN users u ON u.id = g.user_id
       WHERE g.event_id = $1 AND g.status = 'active' AND g.settled_at IS NULL`,
      [eventId],
    );
    const settled: { user_id: string; kind: SettlementKind; points_delta: number }[] = [];
    for (const row of rows) {
      // Spec §2e no-show rule: active Going, window elapsed, no verified
      // check-in, AND permission was granted during the window → no-show.
      // No permission (or dead battery/airplane mode, which surfaces the same
      // way — no fix ever recorded) → unverifiable, neutral, NEVER punished.
      const kind: SettlementKind = row.checked_in
        ? "showup" // checked in but never settled (e.g. server restarted mid-window)
        : row.location_permission_granted ? "no_show" : "unverifiable";
      const delta = kind === "showup" ? SHOWUP_DELTA : kind === "no_show" ? NO_SHOW_DELTA : 0;
      if (!dryRun) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          if (kind === "showup") {
            const u = await client.query<{ verified_checkin_count: number }>(
              "SELECT verified_checkin_count FROM users WHERE id = $1", [row.user_id],
            );
            const wasFirst = (u.rows[0]?.verified_checkin_count ?? 0) === 0;
            await settleGoing(client, row.going_id, row.user_id, eventId, "showup", { bumpCheckins: true });
            if (wasFirst) {
              await client.query(
                "INSERT INTO reputation_ledger (user_id, kind, points_delta, event_id) VALUES ($1, 'first_checkin', 0, $2)",
                [row.user_id, eventId],
              );
            }
          } else {
            await settleGoing(client, row.going_id, row.user_id, eventId, kind);
          }
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
      }
      settled.push({ user_id: row.user_id, kind, points_delta: delta });
    }
    return { event_id: eventId, settled };
  }

  app.post("/api/v1/settlement/run", {
    preHandler: app.authenticate,
  }, async (req, reply) => {
    const now = new Date();
    const { rows } = await pool.query<{ id: string }>(
      `SELECT DISTINCT g.event_id AS id FROM going g JOIN events e ON e.id = g.event_id
       WHERE g.status = 'active' AND g.settled_at IS NULL AND e.start_at + interval '150 minutes' <= $1`,
      [now],
    );
    const results = [];
    for (const row of rows) results.push(await settleEvent(row.id, now, false));
    return reply.send({ ran_at: now.toISOString(), events_settled: results.length, results });
  });

  app.post("/api/v1/events/:id/settle", {
    preHandler: app.authenticate,
  }, async (req, reply) => {
    const { id } = paramsSchema.parse(req.params);
    const q = settleQuerySchema.parse(req.query);
    return reply.send(await settleEvent(id, new Date(), q.dry_run));
  });
}
