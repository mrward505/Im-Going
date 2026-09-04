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
  const { rows } = await pool.query<{ shares_today: number; shares_date: string | null }>(
    "SELECT shares_today, shares_date FROM users WHERE id = $1",
    [userId],
  );
  const row = rows[0];
  if (!row) return { remaining: SHARE_LIMIT_PER_DAY, date: now };
  const sameDay = row.shares_date === now.toISOString().slice(0, 10);
  if (!sameDay) return { remaining: SHARE_LIMIT_PER_DAY, date: now };
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
    `INSERT INTO users (id, shares_today, shares_date)
     VALUES ($1, 1, $2)
     ON CONFLICT (id) DO UPDATE SET
       shares_today = CASE
         WHEN users.shares_date = EXCLUDED.shares_date THEN users.shares_today + 1
         ELSE 1 END,
       shares_date = EXCLUDED.shares_date
     RETURNING shares_today`,
    [userId, day],
  );
  return Math.max(0, SHARE_LIMIT_PER_DAY - rows[0].shares_today);
}