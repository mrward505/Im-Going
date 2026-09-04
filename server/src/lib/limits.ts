/**
 * Rate-limit helpers — MVP guardrails from the spec:
 *  - share rate limit: 10 shares/day per user (§2g)
 *  - check-in caps: 3/day, 10/week (Slice 3 enforcement; helpers exist now)
 */
import type { Pool } from "pg";

export const SHARE_LIMIT_PER_DAY = 10;
export const CHECKIN_CAP_PER_DAY = 3;
export const CHECKIN_CAP_PER_WEEK = 10;

export async function shareBudgetRemaining(
  pool: Pool,
  userId: string,
  now: Date = new Date(),
): Promise<{ remaining: number; date: Date }> {
  // Day comparison happens in SQL (CURRENT_DATE) — node-pg's DATE parsing
  // varies (string vs Date), so never compare the raw value in JS.
  const { rows } = await pool.query<{ shares_today: number; is_today: boolean }>(
    "SELECT shares_today, (shares_date = CURRENT_DATE) AS is_today FROM users WHERE id = $1",
    [userId],
  );
  const row = rows[0];
  if (!row) return { remaining: SHARE_LIMIT_PER_DAY, date: now };
  if (!row.is_today) return { remaining: SHARE_LIMIT_PER_DAY, date: now };
  return {
    remaining: Math.max(0, SHARE_LIMIT_PER_DAY - row.shares_today),
    date: now,
  };
}

/** Increment the daily share counter (UTC-day-based). Returns new remaining. */
export async function consumeShare(
  pool: Pool,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const day = now.toISOString().slice(0, 10);
  const { rows } = await pool.query<{ shares_today: number }>(
    `UPDATE users SET
       shares_today = CASE
         WHEN shares_date = $2::date THEN shares_today + 1
         ELSE 1 END,
       shares_date = $2::date
     WHERE id = $1
     RETURNING shares_today`,
    [userId, day],
  );
  if (!rows[0]) return SHARE_LIMIT_PER_DAY; // user vanished mid-request; fail open on budget
  return Math.max(0, SHARE_LIMIT_PER_DAY - rows[0].shares_today);
}