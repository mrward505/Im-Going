/**
 * Geofence + event-window helpers — spec §2e.
 * Radius by spot type: verified POI 150 m, large venue/concert 400 m,
 * custom residential 100 m. Check-in window:
 *   [start − 30 min, start + 150 min]  (server clock is the authority).
 */

export const EVENT_WINDOW_START_MINUTES_BEFORE = 30;
export const EVENT_WINDOW_END_MINUTES_AFTER = 150;
export const DEFAULT_GEOFENCE_RADIUS_M = 150;
export const LARGE_VENUE_RADIUS_M = 400;
export const CUSTOM_SPOT_RADIUS_M = 100;

/** Effective radius for a spot: stored value wins for verified POIs (seed),
 *  custom spots are pinned to 100 m (server-derived, client cannot choose). */
export function radiusFor(spot: { is_verified: boolean; is_large_venue: boolean; geofence_radius_m: number }): number {
  if (!spot.is_verified) return CUSTOM_SPOT_RADIUS_M;
  if (spot.is_large_venue) return LARGE_VENUE_RADIUS_M;
  return spot.geofence_radius_m > 0 ? spot.geofence_radius_m : DEFAULT_GEOFENCE_RADIUS_M;
}

const R = 6_371_000; // earth radius, meters

/** Haversine great-circle distance in meters. */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface WindowBounds {
  start: Date;
  end: Date;
}

export function eventWindow(startAt: Date | string, now?: Date): WindowBounds {
  const start = new Date(startAt);
  return {
    start: new Date(start.getTime() - EVENT_WINDOW_START_MINUTES_BEFORE * 60_000),
    end: new Date(start.getTime() + EVENT_WINDOW_END_MINUTES_AFTER * 60_000),
  };
}

export function isInsideWindow(startAt: Date | string, now: Date = new Date()): boolean {
  const { start, end } = eventWindow(startAt, now);
  return now >= start && now <= end;
}

export interface SpotGeoFields {
  lat: number;
  lon: number;
  is_verified: boolean;
  is_large_venue: boolean;
  geofence_radius_m: number;
}

export function insideGeofence(spot: SpotGeoFields, fix: { lat: number; lon: number }): boolean {
  return fix.lat === undefined || fix.lon === undefined
    ? false
    : haversineMeters(spot.lat, spot.lon, fix.lat, fix.lon) <= radiusFor(spot);
}

/** Server-side spoofing defense (spec §2e): reject implausible fixes
 *  (consecutive uploads implying > 300 km/h). */
export const MAX_PLAUSIBLE_SPEED_KMH = 300;

export function isImplausibleMove(
  prev: { lat: number; lon: number; at: number } | null,
  fix: { lat: number; lon: number },
  at: number,
): boolean {
  if (!prev) return false;
  const dtHours = (at - prev.at) / 3_600_000;
  if (dtHours <= 0) return true; // non-monotonic server clock
  const km = haversineMeters(prev.lat, prev.lon, fix.lat, fix.lon) / 1000;
  return km / dtHours > MAX_PLAUSIBLE_SPEED_KMH;
}