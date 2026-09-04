/**
 * Reputation math — spec §5, authoritative (engineer proposal, adjustable).
 * star_rating is derived from reputation_points:
 *   star_rating = clamp(1 + points / 250, 1, 5), displayed to one decimal.
 * Points: start 500 (3.0★), show-up +100, no-show −60, soft no-show −30,
 * free cancel 0, unverifiable 0. Floor 0 pts (1.0★), ceiling 1000 pts (5.0★).
 * New-account guard: stars capped at 3.0★ until the first verified check-in.
 */
export const STARTING_POINTS = 500;
export const POINTS_PER_STAR = 250;
export const SHOWUP_DELTA = 100;
export const NO_SHOW_DELTA = -60;
export const SOFT_NO_SHOW_DELTA = -30;
export const FREE_CANCEL_DELTA = 0;
export const UNVERIFIABLE_DELTA = 0;
export const FIRST_CHECKIN_DELTA = 0; // marker entry, no points
export const POINTS_FLOOR = 0;
export const POINTS_CEILING = 1000;
export const STAR_FLOOR = 1.0;
export const STAR_CEILING = 5.0;
export const NEW_ACCOUNT_STAR_CAP = 3.0;

export function clampPoints(points: number): number {
  return Math.min(POINTS_CEILING, Math.max(POINTS_FLOOR, Math.round(points)));
}

/** Exact derivation: clamp(1 + points/250, 1, 5) rounded to one decimal. */
export function starRating(points: number): number {
  const raw = 1 + clampPoints(points) / POINTS_PER_STAR;
  return Math.round(Math.min(STAR_CEILING, Math.max(STAR_FLOOR, raw)) * 10) / 10;
}

/**
 * Stars as displayed/used for weighting. Capped at 3.0★ for accounts without
 * a verified check-in (spec §5 new-account guard). Applies everywhere a star
 * value is exposed (profile, going lists, trending contributions).
 */
export function effectiveStars(points: number, verifiedCheckinCount: number): number {
  const stars = starRating(points);
  return verifiedCheckinCount >= 1 ? stars : Math.min(stars, NEW_ACCOUNT_STAR_CAP);
}

/** Trend contribution floor 0.25: 5★ = 2.0, 4★ = 1.5, 3★ = 1.0, 2★ = 0.5, 1★ = 0.25. */
export function contributionFloor(stars: number): number {
  return Math.max(0.25, Math.min(2.0, 1 + 0.5 * (stars - 3)));
}

/** Apply to a points total; returns the new cached rollup value. */
export function applyDelta(points: number, delta: number): number {
  return clampPoints(points + delta);
}

/** Property tests over the full 0–1000 point range (used by bun test). */
export const STAR_MAPPING = [
  [0, 1.0],
  [250, 2.0],
  [300, 2.2],
  [500, 3.0],
  [740, 4.0], // spec prose says 3.9★; exact formula is authoritative
  [750, 4.0],
  [800, 4.2],
  [1000, 5.0],
] as const;