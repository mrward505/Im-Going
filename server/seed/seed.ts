/**
 * Tempe/ASU venue seed — populates `spots` with ~1,000 REAL, verifiable
 * venues (bars, clubs, restaurants, coffee, concert/campus hangouts) for the
 * single-city launch (spec §2b: "MVP seed: ~1,000 real Tempe, AZ venues").
 *
 * Data source: OpenStreetMap (ODbL). Every venue carries its OSM element ref
 * (node/way/relation + id) in server/src/data/tempe-venues.ts so any entry can
 * be checked at openstreetmap.org — zero fabricated venues.
 *
 * IDEMPOTENT: safe to re-run. Matching is (name+address) exact, or the spec
 * §2b fuzzy match (canonical-name similarity ≥ 0.87 AND within 200 m) against
 * seeded verified spots. Re-runs UPDATE (address/coords/category/radius) and
 * never duplicate.
 *
 * Usage:
 *   cd server && bun run seed           # apply
 *   cd server && bun run seed:check     # report only, no writes
 */
import { Pool } from "pg";
import { levenshtein, nameSimilarity, FUZZY_NAME_THRESHOLD, haversineMeters, SAME_PLACE_RADIUS_M } from "../src/lib/fuzzy";
import { TEMPE_VENUES } from "../src/data/tempe-venues";
import { METRO_VENUES } from "../src/data/metro-venues";

interface SeedVenue {
  name: string;
  address: string | null;
  lat: number;
  lon: number;
  category: "bar" | "club" | "concert" | "restaurant" | "house" | "other";
  is_large_venue: boolean;
}

// Anchor first (Tempe/Overpass), then metro (Nominatim) — one dedup pass over
// the combined list, so metro rows that duplicate Tempe rows update in place.
const ALL_VENUES: (SeedVenue & { city: string })[] = [
  ...TEMPE_VENUES.map((v) => ({ ...v, city: "Tempe" as const })),
  ...METRO_VENUES.map((v) => ({ ...v, city: v.city })),
];

// Spec §2e geofence radii: verified POI 150 m; large venue/concert 400 m.
const POI_RADIUS_M = 150;
const LARGE_VENUE_RADIUS_M = 400;

interface DbSpot {
  id: string;
  name: string;
  address: string | null;
  lat: number;
  lon: number;
}

function loadDatabaseUrl(): string {
  const env = process.env.DATABASE_URL;
  if (env) return env;
  try {
    const text = require("node:fs").readFileSync(new URL("../.env", import.meta.url), "utf8");
    const m = text.match(/^DATABASE_URL=(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    // .env may not set DATABASE_URL; fall back to the team dev default
    if (text.includes("imgoing")) return "postgres://imgoing:imgoing_dev_password@127.0.0.1:5432/imgoing";
  } catch {
    /* no .env — use the canonical dev default */
  }
  return "postgres://imgoing:imgoing_dev_password@127.0.0.1:5432/imgoing";
}

/** Geofence radius by spot type (spec §2e): 400 m for large venues, 150 m standard. */
export function radiusForVenue(isLarge: boolean): number {
  return isLarge ? LARGE_VENUE_RADIUS_M : POI_RADIUS_M;
}

async function fetchCandidateSpots(pool: Pool): Promise<DbSpot[]> {
  const { rows } = await pool.query<DbSpot>(
    `SELECT id, name, address, lat, lon FROM spots WHERE is_verified = true`,
  );
  return rows;
}

/**
 * Find an existing verified spot that is the same physical place:
 * exact (name+address) first, then §2b fuzzy (similar name AND ≤ 200 m).
 * Scans candidates in memory (~1k rows) — one query per venue is avoided.
 */
export async function findExistingVenue(
  pool: Pool,
  venue: { name: string; address: string | null; lat: number; lon: number },
  candidates: DbSpot[],
): Promise<DbSpot | undefined> {
  // 1) exact name+address (case-insensitive, trimmed)
  if (venue.address) {
    const { rows } = await pool.query<DbSpot>(
      `SELECT id, name, address, lat, lon FROM spots
       WHERE is_verified = true
         AND lower(btrim(name)) = lower(btrim($1))
         AND lower(btrim(COALESCE(address, ''))) = lower(btrim($2))
       LIMIT 1`,
      [venue.name, venue.address],
    );
    if (rows[0]) return rows[0];
  }
  // 2) fuzzy: name similarity + distance, in memory
  let best: { spot: DbSpot; score: number } | undefined;
  for (const cand of candidates) {
    const dist = haversineMeters(venue.lat, venue.lon, cand.lat, cand.lon);
    if (dist > SAME_PLACE_RADIUS_M) continue;
    const sim = nameSimilarity(venue.name, cand.name);
    if (sim >= FUZZY_NAME_THRESHOLD && (!best || sim > best.score)) best = { spot: cand, score: sim };
  }
  return best?.spot;
}

export async function seedVenues(dryRun = false): Promise<Report> {
  const pool = new Pool({ connectionString: loadDatabaseUrl() });
  try {
    const { rows: cnt } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM spots WHERE is_verified = true`,
    );
    const before = cnt[0].n;
    const candidates = await fetchCandidateSpots(pool);

    let inserted = 0, updated = 0, skipped = 0, inFileDupes = 0;
    const insertedNames: string[] = [];

    // Chunked transaction: one commit per 200 venues keeps each statement
    // stream small while the whole run stays restartable (re-run = no-op).
    const CHUNK = 200;
    for (let i = 0; i < ALL_VENUES.length; i += CHUNK) {
      const chunk = ALL_VENUES.slice(i, i + CHUNK);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const v of chunk) {
          const existing = await findExistingVenue(pool, v, candidates);
          const radius = radiusForVenue(v.is_large_venue);
          if (existing) {
            if (existing.id === "pending") {
              // Duplicate of a venue already handled in THIS run — the DB row
              // for the first copy exists (or will), so there is nothing to
              // write for the copy. (Candidates pushed below use this
              // sentinel id to keep in-file dedup in-memory only.)
              inFileDupes++;
            } else if (!dryRun) {
              await client.query(
                `UPDATE spots SET address = COALESCE(address, $2), lat = $3, lon = $4,
                        geofence_radius_m = $5, category = $6, is_large_venue = $7, city = $8
                 WHERE id = $1`,
                [existing.id, v.address, v.lat, v.lon, radius, v.category, v.is_large_venue, v.city],
                // Note: address is COALESCEd so a previously-set address is never blanked.
              );
              updated++;
            } else {
              updated++;
            }
          } else {
            if (!dryRun) {
              await client.query(
                `INSERT INTO spots (name, address, lat, lon, geofence_radius_m, category, is_verified, is_large_venue, city, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, NULL)`,
                [v.name, v.address, v.lat, v.lon, radius, v.category, v.is_large_venue, v.city],
              );
            }
            inserted++;
            insertedNames.push(v.name);
            // Keep candidates fresh so two identical entries inside the file
            // also dedup against each other (sentinel id: never written to DB).
            candidates.push({ id: "pending", name: v.name, address: v.address, lat: v.lat, lon: v.lon });
          }
        }
        if (!dryRun) await client.query("COMMIT");
        else await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    }

    return {
      total: ALL_VENUES.length,
      inserted,
      updated,
      skipped: inFileDupes,
      before,
      after: before + inserted,
      insertedNames,
    };
  } finally {
    await pool.end();
  }
}

export interface Report {
  total: number;
  inserted: number;
  updated: number;
  skipped: number;
  before: number;
  after: number;
  insertedNames: string[];
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "§");

if (isMain) {
  const dryRun = process.argv.includes("--check") || process.argv.includes("--dry");
  seedVenues(dryRun)
    .then((r) => {
      console.log(
        [
          `venues in seed file : ${r.total}`,
          `verified spots before: ${r.before}`,
          `inserted             : ${r.inserted}`,
          `updated (matched)    : ${r.updated}`,
          `verified spots after : ${r.after}`,
          dryRun ? "(dry run — nothing written)" : "seed complete",
        ].join("\n"),
      );
      if (r.insertedNames.length && r.insertedNames.length <= 20) console.log(r.insertedNames.join(", "));
      process.exit(0);
    })
    .catch((err) => {
      console.error("seed failed:", err);
      process.exit(1);
    });
}
