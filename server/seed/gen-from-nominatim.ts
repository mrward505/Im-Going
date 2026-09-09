/**
 * GEN SCRIPT (dev-time tool): turns Nominatim (OSM, ODbL) POI dumps harvested
 * per query into the curated metro venue seed module committed at
 * server/src/data/metro-venues.ts.
 *
 * Input:  /tmp/pois/<City>__<query>.json  (Nominatim jsonv2, addressdetails=1)
 * Output: server/src/data/metro-venues.ts (METRO_VENUES, Tempe excluded —
 *         Tempe keeps its Overpass-built file as the anchor).
 *
 * Honesty rules (same bar as the Tempe Overpass pipeline):
 * - real venues only: every entry carries its OSM element ref (osm_type/osm_id)
 *   so anyone can verify it on openstreetmap.org — never invent names,
 *   addresses, or coordinates;
 * - city is set from the record (address city/town/village when it names one
 *   of the 7 metro cities, else the harvest file's city) — no default leakage;
 * - coords must fall inside one of the 7 metro bboxes or the record is dropped;
 * - unnamed records, pure address interpolations and administrative boundaries
 *   are dropped; node/way dupes collapse via canonical-name + ~55 m grid key.
 *
 * Usage:
 *   bun server/seed/gen-from-nominatim.ts   # reads /tmp/pois, writes the module
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const POIS_DIR = "/tmp/pois";
const OUT_PATH = new URL("../src/data/metro-venues.ts", import.meta.url).pathname;

export const METRO_CITIES = [
  "Tempe",
  "Scottsdale",
  "Chandler",
  "Phoenix",
  "Mesa",
  "Gilbert",
  "Glendale",
] as const;

// Nominatim city search bounding boxes (south, north, west, east), 2026-09-09.
const BBOX: Record<string, [number, number, number, number]> = {
  Tempe: [33.31986, 33.4639799, -111.9784718, -111.8773587],
  Scottsdale: [33.447629, 33.90052, -111.960976, -111.755884],
  Chandler: [33.2037626, 33.361338, -111.9722335, -111.7553269],
  Phoenix: [33.2904827, 33.9183794, -112.3240289, -111.9255304],
  Mesa: [33.277624, 33.513376, -111.8944023, -111.5805913],
  Gilbert: [33.204638, 33.385792, -111.8420962, -111.686071],
  Glendale: [33.5077852, 33.6979238, -112.4615632, -112.1515638],
};

type Cat = "bar" | "club" | "concert" | "restaurant" | "house" | "other";

interface NomiRec {
  name?: string;
  lat: string;
  lon: string;
  category?: string;
  type?: string;
  addresstype?: string;
  osm_type?: string;
  osm_id?: number;
  address?: Record<string, string>;
  display_name?: string;
}

function canonicalName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an|inc|llc|ltd|co|company)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function gridKey(lat: number, lon: number): string {
  return `${Math.round(lat * 800)}:${Math.round(lon * 800)}`; // ~55 m cells
}

/** Map Nominatim (category:type) to the spec enum. Query-hint fallback second. */
function classify(r: NomiRec, queryHint: string): Cat {
  const key = `${r.category ?? ""}:${r.type ?? ""}`;
  if (/(nightclub|stripclub|karaoke|dance|disco)/.test(key)) return "club";
  if (/(bar|pub|biergarten|beer|hookah|wine|lounge|cocktail)/.test(key)) return "bar";
  if (/(theatre|cinema|stadium|museum|gallery|arts_centre|concert|music_venue|amphitheatre)/.test(key)) return "concert";
  if (/(restaurant|cafe|fast_food|ice_cream|food_court|coffee)/.test(key)) return "restaurant";
  const h = queryHint.toLowerCase().replace(/_/g, " ");
  if (/nightclub|comedy club|dance club|music venue|club/.test(h)) return "club";
  if (/bar|pub|brewery|lounge|winery|beer|hookah|karaoke/.test(h)) return "bar";
  if (/theater|cinema|museum|concert|stadium|arena|gallery|live music/.test(h)) return "concert";
  if (/restaurant|cafe|coffee|fast food|pizza|sushi|tacos/.test(h)) return "restaurant";
  return "other";
}

function buildAddress(a: Record<string, string> | undefined, fallbackCity: string): string | null {
  if (!a) return null;
  const hn = a.house_number;
  const road = a.road;
  if (!hn || !road) return null;
  const city = a.city ?? a.town ?? a.village ?? a.hamlet ?? fallbackCity;
  const zip = a.postcode ? ` ${a.postcode}` : "";
  return `${hn} ${road}, ${city}, AZ${zip}`;
}

function recordCity(r: NomiRec, fileCity: string): string | null {
  const a = r.address ?? {};
  const named = (a.city ?? a.town ?? a.village ?? a.hamlet ?? "").trim();
  const hit = METRO_CITIES.find((c) => c.toLowerCase() === named.toLowerCase());
  if (hit) return hit;
  // County-level or unincorporated records still belong to the harvest city
  // as long as coords land inside its bbox (checked by the caller).
  if (METRO_CITIES.includes(fileCity as (typeof METRO_CITIES)[number])) return fileCity;
  return null;
}

function insideAnyBbox(lat: number, lon: number): boolean {
  return Object.values(BBOX).some(([s, n, w, e]) => lat >= s && lat <= n && lon >= w && lon <= e);
}

export interface MetroSeedVenue {
  name: string;
  address: string | null;
  lat: number;
  lon: number;
  category: Cat;
  is_large_venue: boolean;
  city: string;
  osm: string;
}

export function buildMetroVenues(poisDir = POIS_DIR): { venues: MetroSeedVenue[]; dropped: Record<string, number> } {
  const dropped: Record<string, number> = {};
  const drop = (why: string) => { dropped[why] = (dropped[why] ?? 0) + 1; };
  const seen = new Set<string>();
  const out: MetroSeedVenue[] = [];

  let files: string[];
  try {
    files = readdirSync(poisDir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return { venues: [], dropped: { no_pois_dir: 1 } };
  }

  for (const f of files) {
    const m = f.match(/^([A-Za-z]+)__(.+)\.json$/);
    if (!m) { drop("bad_filename"); continue; }
    const [, fileCity, queryHint] = m;
    let recs: NomiRec[];
    try {
      recs = JSON.parse(readFileSync(join(poisDir, f), "utf8")) as NomiRec[];
    } catch {
      drop("unparseable"); continue;
    }
    for (const r of recs) {
      const name = (r.name ?? "").trim();
      if (!name) { drop("unnamed"); continue; }
      // Nominatim sometimes returns streets/buildings for amenity-flavoured
      // queries — only real visitable POIs count.
      if (r.addresstype === "street" || r.category === "highway" || r.category === "boundary" || r.category === "place") {
        drop("not_a_poi"); continue;
      }
      const lat = parseFloat(r.lat);
      const lon = parseFloat(r.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) { drop("bad_coords"); continue; }
      if (!insideAnyBbox(lat, lon)) { drop("outside_metro"); continue; }
      const city = recordCity(r, fileCity);
      if (!city) { drop("unknown_city"); continue; }
      if (city === "Tempe") continue; // Tempe anchor keeps its Overpass file
      const key = `${canonicalName(name)}|${gridKey(lat, lon)}`;
      if (seen.has(key)) { drop("dupe"); continue; }
      seen.add(key);
      out.push({
        name,
        address: buildAddress(r.address, city),
        lat: Math.round(lat * 1e6) / 1e6,
        lon: Math.round(lon * 1e6) / 1e6,
        category: classify(r, queryHint),
        is_large_venue: /stadium|arena|amphitheatre/.test(`${r.category}:${r.type}`),
        city,
        osm: `${r.osm_type ?? "?"}/${r.osm_id ?? "?"}`,
      });
    }
  }
  out.sort((a, b) => a.city.localeCompare(b.city) || a.name.localeCompare(b.name));
  return { venues: out, dropped };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "§");

if (isMain) {
  const { venues, dropped } = buildMetroVenues();
  const byCity: Record<string, number> = {};
  for (const v of venues) byCity[v.city] = (byCity[v.city] ?? 0) + 1;
  console.log(`unique metro venues (excl. Tempe): ${venues.length}`);
  console.log(`per city: ${JSON.stringify(byCity)}`);
  console.log(`dropped: ${JSON.stringify(dropped)}`);
  const header = `/**
 * Phoenix-metro venue seed (excl. Tempe anchor) — ${venues.length} REAL places
 * compiled from OpenStreetMap via Nominatim (ODbL license; see
 * server/seed/README.md for the pipeline).
 *
 * Generated by server/seed/gen-from-nominatim.ts from harvested Nominatim
 * jsonv2 dumps; every entry carries its OSM element ref (node/way/relation +
 * id) so anyone can verify it on openstreetmap.org. Coordinates are to 6
 * decimal places (~0.1 m) and addresses are OSM address parts when tagged.
 *
 * Spec §4 Spot fields; category enum: bar, club, concert, restaurant, house, other.
 * (Tempe rows live in tempe-venues.ts — the Overpass-built anchor.)
 */
export interface MetroSeedVenue {
  name: string;
  address: string | null;
  lat: number;
  lon: number;
  category: "bar" | "club" | "concert" | "restaurant" | "house" | "other";
  /** true for stadiums/arenas — spec geofence 400 m */
  is_large_venue: boolean;
  city: string;
  /** OSM element ref "node/123" etc. — provenance, not stored in the DB */
  osm: string;
}

export const METRO_CITIES = ${JSON.stringify(METRO_CITIES)} as const;

export const METRO_VENUES: MetroSeedVenue[] = [
`;
  const rows = venues
    .map((v) => `  { name: ${JSON.stringify(v.name)}, address: ${JSON.stringify(v.address)}, lat: ${v.lat}, lon: ${v.lon}, category: ${JSON.stringify(v.category)}, is_large_venue: ${v.is_large_venue}, city: ${JSON.stringify(v.city)}, osm: ${JSON.stringify(v.osm)} },`)
    .join("\n");
  writeFileSync(OUT_PATH, header + rows + "\n];\n");
  console.log(`wrote ${OUT_PATH} with ${venues.length} venues`);
}
