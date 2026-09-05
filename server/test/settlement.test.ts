/**
 * Slice 3 unit tests (no DB) — settlement helpers + share/settlement pure math.
 * Spec §2e (cancel boundary, no-show rule inputs) + §5 (deltas, idempotency shape).
 */
import { describe, expect, test } from "bun:test";
import {
  cancelSettlement, SETTLEMENT_DELTA, SETTLEMENT_LEDGER_KIND,
} from "../src/lib/settlement";
import { SHARE_LIMIT_PER_DAY, CHECKIN_CAP_PER_DAY, CHECKIN_CAP_PER_WEEK } from "../src/lib/limits";

describe("settlement — spec §2e cancel boundary + §5 deltas", () => {
  const start = new Date("2026-09-05T21:00:00Z");
  test("≥ 2 h before start → free cancel (0)", () => {
    expect(cancelSettlement(start, new Date("2026-09-05T19:00:00Z"))).toBe("free_cancel");
    expect(cancelSettlement(start, new Date("2026-09-05T18:00:00Z"))).toBe("free_cancel");
  });
  test("< 2 h before start → soft no-show", () => {
    expect(cancelSettlement(start, new Date("2026-09-05T19:00:01Z"))).toBe("soft_no_show");
    expect(cancelSettlement(start, new Date("2026-09-05T20:59:00Z"))).toBe("soft_no_show");
  });
  test("exact spec deltas: +100 / −60 / −30 / 0 / 0", () => {
    expect(SETTLEMENT_DELTA).toMatchObject({
      showup: 100, no_show: -60, soft_no_show: -30, free_cancel: 0, unverifiable: 0,
    });
  });
  test("only point-moving outcomes get ledger rows", () => {
    expect(SETTLEMENT_LEDGER_KIND.showup).toBe("showup");
    expect(SETTLEMENT_LEDGER_KIND.no_show).toBe("no_show");
    expect(SETTLEMENT_LEDGER_KIND.soft_no_show).toBe("soft_no_show");
    expect(SETTLEMENT_LEDGER_KIND.free_cancel).toBeNull();
    expect(SETTLEMENT_LEDGER_KIND.unverifiable).toBeNull();
  });
  test("guardrail constants: 10 shares/day, 3 check-ins/day, 10/week", () => {
    expect(SHARE_LIMIT_PER_DAY).toBe(10);
    expect(CHECKIN_CAP_PER_DAY).toBe(3);
    expect(CHECKIN_CAP_PER_WEEK).toBe(10);
  });
});
