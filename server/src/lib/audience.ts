import type { Pool } from "pg";

/**
 * Live-audience aggregates (Slice 4d-3a) — every number comes from real
 * Going/Event rows. No invented numbers, ever.
 *
 * HEAT — a badge for "this spot is popping RIGHT NOW", derived only from
 * real confirmations: active Going rows created in the last 60 minutes on
 * events at the spot (re-confirms count — flipping cancelled→active rewrites
 * created_at, which is a genuine fresh confirmation signal).
 *
 * Threshold scheme (documented for the PR + client):
 *   heat_count  0–2   → heat_level 0 (calm)
 *   heat_count  3–5   → heat_level 1 (warming)
 *   heat_count  6–11  → heat_level 2 (hot)
 *   heat_count  12+   → heat_level 3 (on_fire)
 * Tuned for the 50–200-user Tempe beta: 3 confirmations in an hour means a
 * real crew just picked the spot; 12+ in an hour is a room filling live.
 */

export const HEAT_WINDOW_MINUTES = 60;
export const HEAT_CALM_MAX = 2; // 0–2 confirmations/hour → calm
export const HEAT_WARMING_MIN = 3; // 3–5 → warming
export const HEAT_HOT_MIN = 6; // 6–11 → hot
export const HEAT_ON_FIRE_MIN = 12; // 12+ → on_fire

export type HeatLevel = 0 | 1 | 2 | 3;

/** Pure bucket function — unit-tested at the boundaries, no DB needed. */
export function heatLevel(recentConfirmations: number): HeatLevel {
  if (recentConfirmations >= HEAT_ON_FIRE_MIN) return 3;
  if (recentConfirmations >= HEAT_HOT_MIN) return 2;
  if (recentConfirmations >= HEAT_WARMING_MIN) return 1;
  return 0;
}

export interface SpotAudience {
  /** Live bodies: active goings on events at this spot whose check-in window
   *  ([start−30m, start+150m], the same rule the app uses) contains now. */
  going_now: number;
  /** Raw confirmation velocity: active goings created in the last 60 min. */
  heat_count: number;
  heat_level: HeatLevel;
}

/**
 * One query for the whole live-audience snapshot of a spot. Window math is
 * written to mirror eventWindow() in lib/geofence.ts exactly (server clock).
 */
export async function spotAudience(pool: Pool, spotId: string): Promise<SpotAudience> {
  const { rows } = await pool.query<{ going_now: number; heat_count: number }>(
    `SELECT
       (SELECT count(*)::int FROM going g JOIN events e ON e.id = g.event_id
         WHERE e.spot_id = $1 AND e.status = 'active' AND g.status = 'active'
           AND e.start_at - interval '30 minutes' <= now()
           AND e.start_at + interval '150 minutes' >= now()) AS going_now,
       (SELECT count(*)::int FROM going g JOIN events e ON e.id = g.event_id
         WHERE e.spot_id = $1 AND e.status = 'active' AND g.status = 'active'
           AND g.created_at >= now() - interval '60 minutes') AS heat_count`,
    [spotId],
  );
  const heat_count = rows[0]?.heat_count ?? 0;
  return { going_now: rows[0]?.going_now ?? 0, heat_count, heat_level: heatLevel(heat_count) };
}

/** "N people are going with you": active goings on an event, excluding me. */
export async function goingWithYou(pool: Pool, eventId: string, userId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM going WHERE event_id = $1 AND status = 'active' AND user_id <> $2",
    [eventId, userId],
  );
  return rows[0]?.n ?? 0;
}

export interface InfluencerPull {
  /** Events this user announced (events.created_by = user). */
  announcements_total: number;
  /** Live audience drawn: active goings on those events, excluding the creator's own rows. */
  confirmations_drawn_total: number;
  /** Follow-through 0–100 (1 decimal): showups ÷ goers with an attendance
   *  verdict (showup / no_show / soft_no_show). free_cancel, unverifiable and
   *  pending rows are non-verdicts (spec: neutral, never punished) and are
   *  excluded. Null when no goer has a verdict yet. */
  goers_follow_through_pct: number | null;
  /** Audience per announcement: drawn ÷ announcements (2 decimals), null with no announcements. */
  avg_confirmations_per_announcement: number | null;
}

/** Real-aggregate influencer pull — all from going/events tables. */
export async function influencerPull(pool: Pool, userId: string): Promise<InfluencerPull> {
  const { rows } = await pool.query<{
    announcements_total: number;
    confirmations_drawn_total: number;
    showups: number;
    verdicts: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM events WHERE created_by = $1) AS announcements_total,
       (SELECT count(*)::int FROM going g JOIN events e ON e.id = g.event_id
         WHERE e.created_by = $1 AND g.status = 'active' AND g.user_id <> $1) AS confirmations_drawn_total,
       (SELECT count(*)::int FROM going g JOIN events e ON e.id = g.event_id
         WHERE e.created_by = $1 AND g.user_id <> $1 AND g.settlement_kind = 'showup') AS showups,
       (SELECT count(*)::int FROM going g JOIN events e ON e.id = g.event_id
         WHERE e.created_by = $1 AND g.user_id <> $1
           AND g.settlement_kind IN ('showup', 'no_show', 'soft_no_show')) AS verdicts`,
    [userId],
  );
  const r = rows[0] ?? {
    announcements_total: 0,
    confirmations_drawn_total: 0,
    showups: 0,
    verdicts: 0,
  };
  return {
    announcements_total: r.announcements_total,
    confirmations_drawn_total: r.confirmations_drawn_total,
    goers_follow_through_pct:
      r.verdicts === 0 ? null : Math.round((r.showups / r.verdicts) * 1000) / 10,
    avg_confirmations_per_announcement:
      r.announcements_total === 0
        ? null
        : Math.round((r.confirmations_drawn_total / r.announcements_total) * 100) / 100,
  };
}
