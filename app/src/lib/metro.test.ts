/**
 * Unit tests for the metro-map geometry (pure module — runs with `bun test`
 * from app/, no React Native runtime needed).
 */
import { describe, expect, test } from "bun:test";
import {
  METRO_BOUNDS,
  METRO_CITY_ANCHORS,
  distanceM,
  formatDistanceM,
  pinRadius,
  project,
  unproject,
} from "./metro";

describe("project / unproject", () => {
  test("round-trips the metro center", () => {
    const p = project(33.45, -111.95);
    const back = unproject(p.x, p.y);
    expect(back.lat).toBeCloseTo(33.45, 5);
    expect(back.lon).toBeCloseTo(-111.95, 5);
  });

  test("all 7 real city anchors project inside the unit square", () => {
    for (const city of Object.keys(METRO_CITY_ANCHORS)) {
      const { lat, lon } = METRO_CITY_ANCHORS[city];
      const p = project(lat, lon);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
  });

  test("city relative layout matches reality (Glendale west, Mesa east, Chandler south)", () => {
    const glendale = project(METRO_CITY_ANCHORS.Glendale.lat, METRO_CITY_ANCHORS.Glendale.lon);
    const mesa = project(METRO_CITY_ANCHORS.Mesa.lat, METRO_CITY_ANCHORS.Mesa.lon);
    const chandler = project(METRO_CITY_ANCHORS.Chandler.lat, METRO_CITY_ANCHORS.Chandler.lon);
    const scottsdale = project(METRO_CITY_ANCHORS.Scottsdale.lat, METRO_CITY_ANCHORS.Scottsdale.lon);
    expect(glendale.x).toBeLessThan(mesa.x);
    expect(chandler.y).toBeGreaterThan(scottsdale.y); // smaller y = more north
    expect(METRO_BOUNDS.latMin).toBeLessThan(METRO_BOUNDS.latMax);
    expect(METRO_BOUNDS.lonMin).toBeLessThan(METRO_BOUNDS.lonMax);
  });

  test("out-of-bounds points clamp instead of NaN", () => {
    const p = project(99, -999);
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
    expect(p.x).toBe(0);
    expect(p.y).toBe(0);
  });
});

describe("pinRadius", () => {
  test("quiet venues keep the base radius (never invented size)", () => {
    expect(pinRadius(0)).toBe(6);
    expect(pinRadius(0, 5, 16)).toBe(5);
  });
  test("grows sub-linearly and caps at max", () => {
    expect(pinRadius(1)).toBeGreaterThan(6);
    expect(pinRadius(1000)).toBe(16);
  });
});

describe("distanceM / formatDistanceM", () => {
  test("Tempe–Phoenix downtown is roughly 10–20 km apart", () => {
    const d = distanceM(METRO_CITY_ANCHORS.Tempe, METRO_CITY_ANCHORS.Phoenix);
    expect(d).toBeGreaterThan(10_000);
    expect(d).toBeLessThan(20_000);
  });
  test("formatDistanceM renders honestly", () => {
    expect(formatDistanceM(400)).toBe("400 m away");
    expect(formatDistanceM(1234.5)).toBe("1.2 km away");
    expect(formatDistanceM(null)).toBeNull();
    expect(formatDistanceM(undefined)).toBeNull();
  });
});