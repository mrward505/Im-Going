/**
 * Name/address fuzzy matching for spec §2b: "Duplicate spot creation is
 * prevented by name/address fuzzy match." Used by both the venue seed
 * (server/seed/seed.ts) and the custom-spot create route (routes/spots.ts).
 *
 * Matching = same canonical name AND coordinates within `radiusM`.
 * Canonicalization strips punctuation, articles and corporate suffixes so
 * "Casey Moore's Oyster House" ≈ "Casey Moores Oyster House"; the radius check
 * keeps legitimate branches of the same brand (Starbucks #472 vs #1093) as
 * distinct spots.
 */

/** Lowercase, strip punctuation/articles/corp suffixes, collapse whitespace. */
export function canonicalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[’'`´]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an|inc|llc|ltd|co|corp|company)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Levenshtein edit distance (iterative, single row). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** 0..1 similarity of two strings after canonicalization (1 = identical). */
export function nameSimilarity(a: string, b: string): number {
  const ca = canonicalizeName(a);
  const cb = canonicalizeName(b);
  if (!ca || !cb) return 0;
  if (ca === cb) return 1;
  const d = levenshtein(ca, cb);
  return 1 - d / Math.max(ca.length, cb.length);
}

/** Haversine distance in meters (matches lib/geofence.ts math). */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Threshold: names this similar (plus nearby coordinates) count as duplicates. */
export const FUZZY_NAME_THRESHOLD = 0.87;
/** Coordinates closer than this (m) can be the same place; beyond is a branch. */
export const SAME_PLACE_RADIUS_M = 200;

/**
 * True when (name, coords) describe the same physical place as an existing
 * spot — the §2b fuzzy-match duplicate test.
 */
export function isSamePlace(
  nameA: string,
  latA: number,
  lonA: number,
  nameB: string,
  latB: number,
  lonB: number,
): boolean {
  if (haversineMeters(latA, lonA, latB, lonB) > SAME_PLACE_RADIUS_M) return false;
  return nameSimilarity(nameA, nameB) >= FUZZY_NAME_THRESHOLD;
}
