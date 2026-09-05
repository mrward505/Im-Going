import type { Pool, PoolClient } from "pg";
import { applyDelta, starRating } from "./reputation";

/**
 * Settlement bookkeeping shared by check-in, cancel, and the settlement
 * runner (spec §2e window/cancel rules, §5 points math).
 *
 * SettlementKind is the terminal outcome written to going.settlement_kind.
 * Only showup / no_show / soft_no_show move points (and get ledger rows);
 * free_cancel and unverifiable carry 0 and live on the Going row only.
 */

export type SettlementKind = "showup" | "no_show" | "soft_no_show" | "free_cancel" | "unverifiable";

/** Cancellation outcome from the server clock (spec §2e): ≥ 2 h before start → free, else soft. */
export function cancelSettlement(startAt: Date | string, now: Date = new Date()): SettlementKind {
  const hoursBefore = (new Date(startAt).getTime() - now.getTime()) / 3_600_000;
  return hoursBefore >= 2 ? "free_cancel" : "soft_no_show";
}

export const SETTLEMENT_LEDGER_KIND: Record<SettlementKind, "showup" | "no_show" | "soft_no_show" | null> = {
  showup: "showup",
  no_show: "no_show",
  soft_no_show: "soft_no_show",
  free_cancel: null,
  unverifiable: null,
};

export const SETTLEMENT_DELTA: Record<SettlementKind, number> = {
  showup: 100,
  no_show: -60,
  soft_no_show: -30,
  free_cancel: 0,
  unverifiable: 0,
};

export interface SettleResult {
  kind: SettlementKind;
  points_delta: number;
  reputation_points: number;
  star_rating: number;
  ledger_id: string | null;
}

/**
 * Settle a Going row: stamp (settlement_kind, settled_at) ONCE, then apply
 * the ledger delta and refresh the user's cached points/stars/checkin count.
 * Idempotent — a second call for the same row returns the recorded outcome
 * without writing anything. Must be called with the Going row locked
 * (FOR UPDATE) or from settleBatch which does its own guard; re-checks the
 * recorded settlement inside the transaction so concurrent calls can't
 * double-append.
 *
 * @param bumpCheckins increment verified_checkin_count (check-in path only).
 */
export async function settleGoing(
  client: Pool | PoolClient,
  goingId: string,
  userId: string,
  eventId: string,
  kind: SettlementKind,
  opts: { bumpCheckins?: boolean } = {},
): Promise<SettleResult> {
  const existing = await client.query<{ settlement_kind: SettlementKind | null }>(
    "SELECT settlement_kind FROM going WHERE id = $1",
    [goingId],
  );
  const recorded = existing.rows[0]?.settlement_kind ?? null;
  if (recorded) {
    const user = await client.query<{ reputation_points: number; verified_checkin_count: number }>(
      "SELECT reputation_points, verified_checkin_count FROM users WHERE id = $1",
      [userId],
    );
    const pts = user.rows[0]?.reputation_points ?? 500;
    return {
      kind: recorded,
      points_delta: SETTLEMENT_DELTA[recorded],
      reputation_points: pts,
      star_rating: starRating(pts),
      ledger_id: null,
    };
  }

  const delta = SETTLEMENT_DELTA[kind];
  const ledgerKind = SETTLEMENT_LEDGER_KIND[kind];
  let ledgerId: string | null = null;

  const userRow = await client.query<{ reputation_points: number }>(
    "SELECT reputation_points FROM users WHERE id = $1",
    [userId],
  );
  const before = userRow.rows[0]?.reputation_points ?? 500;
  const after = applyDelta(before, delta);

  if (ledgerKind) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO reputation_ledger (user_id, kind, points_delta, event_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, ledgerKind, delta, eventId],
    );
    ledgerId = inserted.rows[0].id;
  }

  await client.query(
    `UPDATE users
     SET reputation_points = $2::int,
         star_rating = 1 + $2::numeric / 250,
         verified_checkin_count = verified_checkin_count + $3::int
     WHERE id = $1`,
    [userId, after, opts.bumpCheckins ? 1 : 0],
  );
  await client.query(
    "UPDATE going SET settlement_kind = $2, settled_at = now() WHERE id = $1",
    [goingId, kind],
  );

  return {
    kind,
    points_delta: delta,
    reputation_points: after,
    star_rating: starRating(after),
    ledger_id: ledgerId,
  };
}
