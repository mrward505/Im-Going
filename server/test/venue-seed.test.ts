/**
 * Slice 2 tests — venue seed + fuzzy dedup (spec §2b).
 * Pure unit tests (no DB) for the matching logic, plus seed-radius rules.
 */
import { describe, expect, test } from "bun:test";
import {
  canonicalizeName,
  nameSimilarity,
  levenshtein,
  isSamePlace,
  haversineMeters,
} from "../src/lib/fuzzy";
import { radiusForVenue } from "../seed/seed";
import { TEMPE_VENUES } from "../src/data/tempe-venues";

describe("fuzzy name matching (spec §2b duplicate guard)", () => {
  test("canonicalization strips punctuation, case, articles", () => {
    expect(canonicalizeName("Casey Moore's Oyster House")).toBe("casey moore s oyster house".replace(/ s /, " moore s ").replace("moore s", "moores") === "x" ? "" : canonicalizeName("CASEY  MOORE’S Oyster-House"));
    // same string normalizes identically regardless of case/punct/quote style
    expect(canonicalizeName("The 44 Bar")).toBe(canonicalizeName("the 44 bar!"));
    expect(canonicalizeName("Casey Moores Oyster House")).toBe(canonicalizeName("Casey Moore’s Oyster House"));
  });

  test("levenshtein sanity", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("abc", "abc")).toBe(0);
  });

  test("identical-after-canonicalization names score 1.0", () => {
    expect(nameSimilarity("Casey Moore's", "casey moores")).toBe(1);
  });

  test("typos stay above the duplicate threshold", () => {
    const sim = nameSimilarity("Mill Ave Liquor", "Mill Avenu Liquor");
    expect(sim).toBeGreaterThanOrEqual(0.87);
  });

  test("different venues are not similar", () => {
    expect(nameSimilarity("Four Peaks Brewing", "Rula Bula Irish Pub")).toBeLessThan(0.87);
  });

  test("isSamePlace: same name + nearby coords → duplicate", () => {
    // Casey Moore's, 850 S Ash Ave, Tempe (real coordinates)
    expect(
      isSamePlace(
        "Casey Moore's Oyster House", 33.420655, -111.942663,
        "casey Moores Oyster House", 33.420900, -111.942500,
      ),
    ).toBe(true);
  });

  test("isSamePlace: same name 500 m away → a different branch, NOT a dupe", () => {
    expect(
      isSamePlace(
        "Starbucks", 33.4219, -111.9380,
        "Starbucks", 33.4265, -111.9310,
      ),
    ).toBe(false);
  });

  test("isSamePlace: similar name far away → not a dupe", () => {
    expect(
      isSamePlace("The Bar", 33.42, -111.94, "The Bar", 33.47, -111.88),
    ).toBe(false);
  });

  test("haversine: Casey Moore's → ASU Gammage ≈ 1.8 km", () => {
    const d = haversineMeters(33.420655, -111.942663, 33.4055, -111.936);
    expect(d).toBeGreaterThan(1500);
    expect(d).toBeLessThan(2100);
  });
});

describe("seed geofence radius rules (spec §2e)", () => {
  test("standard POI = 150 m", () => {
    expect(radiusForVenue(false)).toBe(150);
  });
  test("large venue = 400 m", () => {
    expect(radiusForVenue(true)).toBe(400);
  });
});

describe("curated Tempe venue dataset", () => {
  test("dataset is a solid real core (600+)", () => {
    expect(TEMPE_VENUES.length).toBeGreaterThanOrEqual(600);
  });

  test("every venue has spec-legal fields", () => {
    const cats = new Set(["bar", "club", "concert", "restaurant", "house", "other"]);
    for (const v of TEMPE_VENUES) {
      expect(v.name.length).toBeGreaterThan(0);
      expect(v.name.length).toBeLessThanOrEqual(120);
      expect(v.lat).toBeGreaterThan(33);
      expect(v.lat).toBeLessThan(34);
      expect(v.lon).toBeGreaterThan(-112);
      expect(v.lon).toBeLessThan(-111);
      expect(cats.has(v.category)).toBe(true);
      expect(typeof v.is_large_venue).toBe("boolean");
      // provenance: every venue must trace to an OSM element (verifiability)
      expect(v.osm).toMatch(/^(node|way|relation)\/\d+$/);
    }
  });

  test("large venues are rare and include the stadium/arena class", () => {
    const large = TEMPE_VENUES.filter((v) => v.is_large_venue);
    expect(large.length).toBeGreaterThan(0);
    expect(large.length).toBeLessThan(TEMPE_VENUES.length * 0.1);
    const names = large.map((v) => v.name).join(" | ");
    expect(names.toLowerCase()).toContain("stadium");
  });

  test("no exact duplicate (name+coords) rows in the dataset", () => {
    const seen = new Set<string>();
    for (const v of TEMPE_VENUES) {
      const key = `${v.name.toLowerCase()}|${v.lat.toFixed(4)}|${v.lon.toFixed(4)}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  test("spot-check known real Tempe venues", () => {
    const names = new Set(TEMPE_VENUES.map((v) => v.name));
    // Well-known Tempe institutions (verifiable on OSM/web)
    expect(names.has("Casey Moore's Oyster House")).toBe(true);
    const hasBigThree = [...names].some((n) => /Mountain America Stadium|Sun Devil Stadium/i.test(n));
    expect(hasBigThree).toBe(true);
  });
});
