/**
 * Slice 4d-3a unit tests (no DB) — the heat bucket. Boundaries are the
 * contract with the client (heat_level → badge), so they are pinned here:
 *   0–2 confirmations/hour  → 0 (calm)
 *   3–5                     → 1 (warming)
 *   6–11                    → 2 (hot)
 *   12+                     → 3 (on_fire)
 */
import { describe, expect, test } from "bun:test";
import { heatLevel, HEAT_WINDOW_MINUTES, HEAT_ON_FIRE_MIN, HEAT_HOT_MIN, HEAT_WARMING_MIN } from "../src/lib/audience";

describe("heat bucket — spec thresholds", () => {
  test("window and threshold constants", () => {
    expect(HEAT_WINDOW_MINUTES).toBe(60);
    expect(HEAT_WARMING_MIN).toBe(3);
    expect(HEAT_HOT_MIN).toBe(6);
    expect(HEAT_ON_FIRE_MIN).toBe(12);
  });
  test("0–2 confirmations → calm (0)", () => {
    expect(heatLevel(0)).toBe(0);
    expect(heatLevel(1)).toBe(0);
    expect(heatLevel(2)).toBe(0);
  });
  test("boundary 2→3 flips calm→warming; 5 stays warming", () => {
    expect(heatLevel(2)).toBe(0);
    expect(heatLevel(3)).toBe(1);
    expect(heatLevel(5)).toBe(1);
  });
  test("boundary 5→6 flips warming→hot; 11 stays hot", () => {
    expect(heatLevel(5)).toBe(1);
    expect(heatLevel(6)).toBe(2);
    expect(heatLevel(11)).toBe(2);
  });
  test("boundary 11→12 flips hot→on_fire and stays there", () => {
    expect(heatLevel(11)).toBe(2);
    expect(heatLevel(12)).toBe(3);
    expect(heatLevel(500)).toBe(3);
  });
});
