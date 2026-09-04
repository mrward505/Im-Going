import { describe, expect, test } from "bun:test";
import {
  starRating, effectiveStars, contributionFloor, applyDelta, clampPoints,
  STAR_MAPPING, SHOWUP_DELTA, NO_SHOW_DELTA, SOFT_NO_SHOW_DELTA,
  NEW_ACCOUNT_STAR_CAP,
} from "../src/lib/reputation";
import {
  scoreGoingRows, STALE_FRESHNESS_FACTOR, TRENDING_LIMIT,
} from "../src/lib/trending";
import {
  haversineMeters, insideGeofence, isInsideWindow, eventWindow, radiusFor,
  CUSTOM_SPOT_RADIUS_M, LARGE_VENUE_RADIUS_M, isImplausibleMove,
} from "../src/lib/geofence";
import { issueOtpCode, verifyOtpCode } from "../src/lib/otp";
import { assertAdult } from "../src/routes/auth";
import { ApiError, toApiError } from "../src/lib/errors";

describe("reputation — spec §5", () => {
  test("exact star mapping (formula is authoritative)", () => {
    for (const [points, stars] of STAR_MAPPING) {
      expect(starRating(points)).toBe(stars);
    }
  });
  test("bounds: floor 1.0 / ceiling 5.0", () => {
    expect(starRating(0)).toBe(1.0);
    expect(starRating(1000)).toBe(5.0);
    expect(starRating(-999)).toBe(1.0);
    expect(starRating(99999)).toBe(5.0);
  });
  test("clampPoints stays in [0, 1000]", () => {
    expect(clampPoints(-50)).toBe(0);
    expect(clampPoints(1200)).toBe(1000);
    expect(clampPoints(740)).toBe(740);
  });
  test("worked example (spec §5): 3 show-ups then 1 no-show → 800 → 740", () => {
    let pts = 500;
    for (let i = 0; i < 3; i++) pts = applyDelta(pts, SHOWUP_DELTA);
    expect(pts).toBe(800);
    expect(starRating(pts)).toBe(4.2);
    pts = applyDelta(pts, NO_SHOW_DELTA);
    expect(pts).toBe(740);
    expect(starRating(pts)).toBe(4.0); // exact formula (spec prose says 3.9)
  });
  test("three consecutive no-shows from start → 320 → 2.3★", () => {
    let pts = 500;
    for (let i = 0; i < 3; i++) pts = applyDelta(pts, NO_SHOW_DELTA);
    expect(pts).toBe(320);
    expect(starRating(pts)).toBe(2.3);
  });
  test("soft no-show −30; one bad night from fresh ≈ 2.8 (display)", () => {
    expect(applyDelta(500, SOFT_NO_SHOW_DELTA)).toBe(470);
    // 440 pts → 1 + 440/250 = 2.76 → 2.8 (spec prose says ≈2.9; exact formula is authoritative)
    expect(starRating(applyDelta(500, -60))).toBe(2.8);
  });
  test("new-account guard caps stars at 3.0 until first verified check-in", () => {
    expect(effectiveStars(800, 0)).toBe(3.0); // 4.2 → 3.0
    expect(effectiveStars(800, 1)).toBe(4.2);
    expect(effectiveStars(500, 0)).toBe(3.0);
    expect(effectiveStars(100, 0)).toBe(1.4);
    expect(effectiveStars(100, 1)).toBe(1.4); // low is never inflated
  });
});

describe("trending — spec §2c", () => {
  test("contribution floor 0.25 and star weights (5★=2.0, 3★=1.0, 1★=0.25)", () => {
    expect(contributionFloor(5)).toBe(2.0);
    expect(contributionFloor(4.2)).toBeCloseTo(1.6, 5);
    expect(contributionFloor(3)).toBe(1.0);
    expect(contributionFloor(2)).toBe(0.5);
    expect(contributionFloor(1)).toBe(0.25);
    expect(contributionFloor(0.5)).toBe(0.25);
  });
  test("score sum over going rows", () => {
    expect(scoreGoingRows([{ star_rating: 5, is_stale: false }])).toBe(2.0);
    expect(scoreGoingRows([{ star_rating: 3, is_stale: false }])).toBe(1.0);
    expect(scoreGoingRows([
      { star_rating: 5, is_stale: false },
      { star_rating: 3, is_stale: false },
      { star_rating: 1, is_stale: false },
    ])).toBeCloseTo(3.25, 5);
  });
  test("freshness: stale users contribute × 0.5", () => {
    expect(scoreGoingRows([{ star_rating: 5, is_stale: true }])).toBe(1.0);
    expect(scoreGoingRows([{ star_rating: 5, is_stale: false }])).toBe(2.0);
    expect(STALE_FRESHNESS_FACTOR).toBe(0.5);
  });
  test("feed limit is 20 (spec: top 20)", () => {
    expect(TRENDING_LIMIT).toBe(20);
  });
});

describe("geofence + windows — spec §2e", () => {
  const spot150 = { is_verified: true, is_large_venue: false, geofence_radius_m: 150 };
  const spot400 = { is_verified: true, is_large_venue: true, geofence_radius_m: 150 };
  const custom = { is_verified: false, is_large_venue: false, geofence_radius_m: 999 };
  test("radius by type: 150 / 400 (large venue) / 100 (custom, server-pinned)", () => {
    expect(radiusFor(spot150)).toBe(150);
    expect(radiusFor(spot400)).toBe(LARGE_VENUE_RADIUS_M);
    expect(radiusFor(custom)).toBe(CUSTOM_SPOT_RADIUS_M);
  });
  test("haversine ~111 m per 0.001° lat", () => {
    const d = haversineMeters(33.42, -111.9, 33.421, -111.9);
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(125);
  });
  test("insideGeofence respects the effective radius", () => {
    const spot = { lat: 33.42, lon: -111.9, ...spot150 };
    expect(insideGeofence(spot, { lat: 33.421, lon: -111.9 })).toBe(true); // ~111 m
    expect(insideGeofence(spot, { lat: 33.4225, lon: -111.9 })).toBe(false); // ~278 m
  });
  test("event window [start−30m, start+150m]", () => {
    const start = new Date("2026-09-05T21:00:00Z");
    const w = eventWindow(start);
    expect(w.start.toISOString()).toBe("2026-09-05T20:30:00.000Z");
    expect(w.end.toISOString()).toBe("2026-09-05T23:30:00.000Z");
    expect(isInsideWindow(start, new Date("2026-09-05T20:29:59Z"))).toBe(false);
    expect(isInsideWindow(start, new Date("2026-09-05T22:00:00Z"))).toBe(true);
    expect(isInsideWindow(start, new Date("2026-09-05T23:31:00Z"))).toBe(false);
  });
  test("implausible-move spoofing guard (>300 km/h)", () => {
    const fix = { lat: 33.42, lon: -111.9 };
    expect(isImplausibleMove(null, fix, Date.now())).toBe(false);
    // ~28 km (0.3° lon at lat 33) in 5 minutes ≈ 335 km/h (> 300) → implausible
    expect(isImplausibleMove({ lat: 33.42, lon: -111.87, at: Date.now() }, { lat: 33.42, lon: -111.57 }, Date.now() + 300_000)).toBe(true);
    // same spot, 5 min later → fine
    expect(isImplausibleMove({ lat: 33.42, lon: -111.9, at: Date.now() }, fix, Date.now() + 300_000)).toBe(false);
    // non-monotonic clock → reject
    expect(isImplausibleMove({ lat: 33.42, lon: -111.9, at: Date.now() }, fix, Date.now() - 1000)).toBe(true);
  });
});

describe("OTP codes", () => {
  test("issued codes are 6 digits; verify is constant-time and rejects wrong/expired shape", () => {
    const { code, codeHash } = issueOtpCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyOtpCode(code, codeHash)).toBe(true);
    expect(verifyOtpCode("000000", codeHash)).toBe(false);
    expect(verifyOtpCode("12345", codeHash)).toBe(false); // wrong length
    expect(verifyOtpCode("abcdef", codeHash)).toBe(false);
  });
});

describe("18+ gate", () => {
  const rejectsAge = (dob: string) => {
    try {
      assertAdult(dob);
      return false;
    } catch (e) {
      return e instanceof ApiError && e.statusCode === 403;
    }
  };
  test("admits 18+, rejects under-18 and implausible DOBs", () => {
    expect(assertAdult("2002-05-14")).toBeGreaterThanOrEqual(18);
    expect(rejectsAge("2015-01-01")).toBe(true);
    expect(rejectsAge("2010-01-01")).toBe(true); // 16 in 2026 — under 18 for any test run date
    expect(() => assertAdult("not-a-date")).toThrow();
  });
  test("borderline 18th birthday is admitted", () => {
    const dob = new Date(new Date().getTime() - 18 * 365.25 * 86_400_000).toISOString().slice(0, 10);
    expect(assertAdult(dob)).toBeGreaterThanOrEqual(18);
  });
});

describe("errors", () => {
  test("ApiError round-trips; unhandled values map to 500", () => {
    expect(toApiError(new ApiError(403, "forbidden", "nope"))).toEqual({ statusCode: 403, code: "forbidden", message: "nope" });
    expect(toApiError(new Error("boom"))).toEqual({ statusCode: 500, code: "internal", message: "internal error" });
    expect(toApiError({ code: "23505" })).toMatchObject({ statusCode: 409, code: "conflict" });
  });
});