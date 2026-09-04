/**
 * Trending score per spec §2c (MVP formula):
 *   Score = Σ over Going rows on events starting within the next 48h of
 *           [ 1 + 0.5 × (stars − 3) ]
 * with contribution floor 0.25, and a freshness factor: contribution × 0.5
 * for users with no verified check-in in the last 90 days.
 * Only events starting within 48 h count; feed is top 20 sorted score desc,
 * tie-break by soonest start; a spot needs ≥ 1 Going to appear.
 */
import type { Pool } from "pg";
import { contributionFloor } from "./reputation";

export const TRENDING_WINDOW_HOURS = 48;
export const STALE_DAYS = 90;
export const STALE_FRESHNESS_FACTOR = 0.5;
export const TRENDING_LIMIT = 20;

export interface SpotTrendRow {
  spot_id: string;
  name: string;
  address: string | null;
  category: string;
  is_verified: boolean;
  is_large_venue: boolean;
  city: string;
  next_start_at: string;
  going_count: number;
  trending_score: number;
}

/**
 * Pure scorer over per-user going rows (exported + unit tested).
 * Each going row carries the user's star rating and staleness flag.
 */
export function scoreGoingRows(
  rows: { star_rating: number; is_stale: boolean }[],
): number {
  return rows.reduce((sum, r) => {
    const contribution = contributionFloor(Number(r.star_rating));
    return sum + (r.is_stale ? contribution * STALE_FRESHNESS_FACTOR : contribution);
  }, 0);
}

export interface TrendExecOptions {
  limit?: number;
  now?: Date;
}

/**
 * Feed query: events starting within the next 48 h that have ≥ 1 active Going,
 * aggregated per spot, top `limit` by score desc, tie-break by soonest start.
 * Scans active going rows over the window (fine for MVP scale).
 */
export async function spotTrending(pool: Pool, opts: TrendExecOptions = {}): Promise<SpotTrendRow[]> {
  const limit = opts.limit ?? TRENDING_LIMIT;
  const now = opts.now?.toISOString() ?? new Date().toISOString();
  const { rows } = await pool.query<SpotTrendRow>(
    `SELECT s.id              AS spot_id,
            s.name,
            s.address,
            s.category,
            s.is_verified,
            s.is_large_venue,
            s.city,
            e.start_at         AS next_start_at,
            COUNT(*)::int      AS going_count,
            ROUND(SUM(
              LEAST(2.0, GREATEST(0.25, 1 + 0.5 * (u.star_rating - 3)))
              * CASE WHEN u.verified_checkin_count > 0
                        AND u.last_verified_at >= now() - interval '90 days'
                     THEN 1 ELSE 0.5 END
            )::numeric, 2)::float AS trending_score
     FROM events e
     JOIN spots s   ON s.id = e.spot_id
     JOIN going g   ON g.event_id = e.id AND g.status = 'active'
     JOIN users u   ON u.id = g.user_id
     LEFT JOIN LATERAL (
       SELECT MAX(ci.verified_at) AS last_verified_at
       FROM checkins ci WHERE ci.user_id = u.id
     ) lv ON true
     WHERE e.status = 'active'
       AND e.start_at > $1
       AND e.start_at <= $1 + interval '48 hours'
     GROUP BY s.id, s.name, s.address, s.category, s.is_verified, s.is_large_venue,
              s.city, e.start_at, s.lat, s.lon
     ORDER BY trending_score DESC, e.start_at ASC
     LIMIT $2`,
    [now, limit],
  );
  return rows;
}