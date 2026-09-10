/**
 * Metro map geometry for the REVAMP 2 map view — pure, dependency-free
 * (no React Native imports) so the projection logic is unit-testable.
 *
 * A stylized equirectangular projection over the real Phoenix-metro bounding
 * box. Positions are REAL lat/lon from the API projected 1:1; the map never
 * invents or jitters a coordinate. City anchors are real city-center
 * coordinates (public geography), used only for labels — not venues.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

export interface Point {
  x: number; // 0..1 across the map width
  y: number; // 0..1 across the map height
}

/** Real bounding box of the 7 launch cities with margin (all venues fit). */
export const METRO_BOUNDS = {
  latMin: 33.2,
  latMax: 33.72,
  lonMin: -112.42,
  lonMax: -111.62,
} as const;

/** Metro center for default map framing (midpoint of the real bounds). */
export const METRO_CENTER: LatLon = {
  lat: (METRO_BOUNDS.latMin + METRO_BOUNDS.latMax) / 2,
  lon: (METRO_BOUNDS.lonMin + METRO_BOUNDS.lonMax) / 2,
};

/** Real city-center coordinates for labels (public geography, not venues). */
export const METRO_CITY_ANCHORS: Record<string, LatLon> = {
  Tempe: { lat: 33.4255, lon: -111.94 },
  Scottsdale: { lat: 33.4942, lon: -111.9261 },
  Chandler: { lat: 33.3062, lon: -111.8413 },
  Phoenix: { lat: 33.4484, lon: -112.074 },
  Mesa: { lat: 33.4223, lon: -111.8226 },
  Gilbert: { lat: 33.3528, lon: -111.789 },
  Glendale: { lat: 33.5387, lon: -112.186 },
} as const;

/** Latitudes near the metro's median are equirectangular-safe. */
export function project(lat: number, lon: number): Point {
  const { latMin, latMax, lonMin, lonMax } = METRO_BOUNDS;
  const x = (lon - lonMin) / (lonMax - lonMin);
  const y = 1 - (lat - latMin) / (latMax - latMin);
  return { x: clamp01(x), y: clamp01(y) };
}

export function unproject(x: number, y: number): LatLon {
  const { latMin, latMax, lonMin, lonMax } = METRO_BOUNDS;
  return {
    lat: latMin + (1 - clamp01(y)) * (latMax - latMin),
    lon: lonMin + clamp01(x) * (lonMax - lonMin),
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Haversine distance in meters (used by "near me" UI copy). */
export function distanceM(a: LatLon, b: LatLon): number {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Pin radius in px scaled by the REAL going count (0 → base). Purely visual
 * amplitude — the count itself is never altered.
 */
export function pinRadius(goingCount: number, base = 6, max = 16): number {
  if (goingCount <= 0) return base;
  return Math.min(base + Math.sqrt(goingCount) * 1.6, max);
}

/** Format a real distance for the map card ("1.2 km away"). */
export function formatDistanceM(m: number | null | undefined): string | null {
  if (m == null || !Number.isFinite(m)) return null;
  if (m < 1000) return `${Math.round(m)} m away`;
  return `${(m / 1000).toFixed(1)} km away`;
}