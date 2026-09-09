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
 * - coords must land inside the metro outer bounds (union of the 7 city
 *   bboxes) ±0.02° or the record is dropped; anything in/near the metro area
 *   survives even if it falls in a seam between two city bboxes;
 * - only place-like POIs are kept (amenity/leisure/tourism/shop/historic/
 *   sport/craft/office/healthcare/etc. objects). Pure address rows
 *   (addresstype=street), highway/boundary/place/building/landuse/natural/
 *   waterway/railway/aeroway/barrier/power/military objects and anything
 *   tagged disused/abandoned/construction/planned/proposed are dropped;
 * - unnamed records are dropped; node/way dupes collapse via
 *   canonical-name + ~55 m grid key, metro-wide (not per-city); on a
 *   collision the row with the most complete address wins.
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

// Metro outer bounds = union of the 7 city bboxes, padded by 0.02° so seams
// between city boxes (and border suburbs within the metro region) are not
// discarded. Genuine sanity bound for "is this in the Phoenix metro at all?".
const METRO_LAT_S = Math.min(...Object.values(BBOX).map((b) => b[0])) - 0.02;
const METRO_LAT_N = Math.max(...Object.values(BBOX).map((b) => b[1])) + 0.02;
const METRO_LON_W = Math.min(...Object.values(BBOX).map((b) => b[2])) - 0.02;
const METRO_LON_E = Math.max(...Object.values(BBOX).map((b) => b[3])) + 0.02;

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
  place_rank?: number;
  address?: Record<string, string>;
  extratags?: Record<string, string>;
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

// Object classes that are NOT visitable POIs for a nightlife app — pure
// address rows, transport/geography/buildings/neighbourhoods, and anything
// in a non-operating lifecycle state. Everything else (amenity, leisure,
// tourism, shop, historic, sport, craft, office, healthcare, ...) is kept —
// deliberately NOT a tiny whitelist, so genuinely place-like records survive.
const NON_POI_CATEGORIES = new Set([
  "highway", "boundary", "place", "building", "landuse", "natural",
  "waterway", "railway", "aeroway", "barrier", "power", "military",
  "man_made", "emergency", "route", "water", "tunnel", "bridge", "mountain_pass",
]);
const LIFECYCLE_RE = /(^|_)(disused|abandoned|construction|planned|proposed|demolished|removed|razed)(_|$)/;

function isNonPoi(r: NomiRec): boolean {
  if (r.addresstype === "street") return true;
  const cat = r.category ?? "";
  if (NON_POI_CATEGORIES.has(cat)) return true;
  if (cat === "place" || cat === "building") return true;
  // extratags may carry lifecycle states (e.g. disused:amenity=bar → the
  // category is still "amenity" but the venue is not operating).
  const et = r.extratags ?? {};
  for (const [k, v] of Object.entries(et)) {
    if (LIFECYCLE_RE.test(k) || LIFECYCLE_RE.test(v)) return true;
  }
  return false;
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
  // (the query was "<q> in <city>"); coords sanity is checked by the caller.
  if (METRO_CITIES.includes(fileCity as (typeof METRO_CITIES)[number])) return fileCity;
  return null;
}

function insideMetro(lat: number, lon: number): boolean {
  return lat >= METRO_LAT_S && lat <= METRO_LAT_N && lon >= METRO_LON_W && lon <= METRO_LON_E;
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
  // metro-wide dedup: canonical-name + ~55 m grid cell => best row wins
  const best = new Map<string, { v: MetroSeedVenue; addrLen: number }>();
  let rawSeen = 0;

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
      if (!Array.isArray(recs)) { drop("bad_file_shape"); continue; }
    } catch {
      drop("unparseable"); continue;
    }
    for (const r of recs) {
      rawSeen++;
      const name = (r.name ?? "").trim();
      if (!name) { drop("unnamed"); continue; }
      if (isNonPoi(r)) { drop("not_a_poi"); continue; }
      const lat = parseFloat(r.lat);
      const lon = parseFloat(r.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) { drop("bad_coords"); continue; }
      if ((lat === 0 && lon === 0) || !insideMetro(lat, lon)) { drop("outside_metro"); continue; }
      const city = recordCity(r, fileCity);
      if (!city) { drop("unknown_city"); continue; }
      if (city === "Tempe") { drop("tempe_excluded"); continue; } // Tempe anchor keeps its Overpass file
      const key = `${canonicalName(name)}|${gridKey(lat, lon)}`;
      const candidate: MetroSeedVenue = {
        name,
        address: buildAddress(r.address, city),
        lat: Math.round(lat * 1e6) / 1e6,
        lon: Math.round(lon * 1e6) / 1e6,
        category: classify(r, queryHint),
        is_large_venue: /stadium|arena|amphitheatre/.test(`${r.category}:${r.type}`),
        city,
        osm: `${r.osm_type ?? "?"}/${r.osm_id ?? "?"}`,
      };
      const prev = best.get(key);
      if (!prev) { best.set(key, { v: candidate, addrLen: candidate.address?.length ?? 0 }); continue; }
      // Same venue found again (across query files/cities): keep the row with
      // the most complete address; ties keep the first (osmA ref stable).
      const addrLen = candidate.address?.length ?? 0;
      if (addrLen > prev.addrLen) {
        best.set(key, { v: candidate, addrLen });
        drop("dupe_better_address");
      } else {
        drop("dupe");
      }
    }
  }
  const venues = [...best.values()].map((e) => e.v);
  venues.sort((a, b) => a.city.localeCompare(b.city) || a.name.localeCompare(b.name));
  if (process.argv[1]?.includes("gen-from-nominatim")) {
    console.log(`audit: raw_seen=${rawSeen} files=${files.length} kept=${venues.length}`);
  }
  return { venues, dropped };
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