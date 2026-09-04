# Tempe/ASU Venue Seed (Slice 2)

Populates the `spots` table with **806 REAL, verifiable venues** for the
single-city launch (spec §2b: "MVP seed: ~1,000 real Tempe, AZ venues").

## Data source & honesty

Every venue was pulled from **OpenStreetMap via the Overpass API** (ODbL) on
2026-09-04. **Zero fabricated venues.** Each entry in
`src/data/tempe-venues.ts` carries its `osm` provenance field
(`node/<id>`, `way/<id>`, or `relation/<id>`), so anyone can verify any venue
by opening `https://www.openstreetmap.org/<element>/<id>` — name, address and
coordinates are exactly what OSM records.

Filters applied at generation time: must have a `name`; not disused/private;
`addr:city` = Tempe when tagged (else inside Tempe's bbox 33.32–33.475 /
-111.98–-111.893, which excludes Guadalupe via its city tag); node/way
duplicates collapsed via canonical-name + ~55 m grid-key dedup.

Category mapping to the spec enum: bars/pubs/hookah → `bar`;
nightclubs/music venues → `club`; theatres/concert halls/stadiums/museums/
cinemas/breweries → `concert`; restaurants/cafes/fast food/coffee →
`restaurant`; parks/malls/arcades/campus buildings/libraries/other hangouts →
`other`. (`house` is reserved for user-created custom spots; seeds never
emit it.) `is_large_venue=true` is set for the stadium/arena/concert-hall
class — those get the spec's 400 m geofence; all other POIs get 150 m.

## Usage

```bash
cd server
bun run migrate      # ensure schema
bun run seed         # apply (idempotent — safe to re-run)
bun run seed:check   # report only, no writes
```

Verified result on the dev DB: **801 verified spots** (806 in the seed file;
the small delta is venues that fuzzy-matched test-fixture rows such as
`The 44` / `ASU Gammage`, which get updated rather than duplicated, plus
2 exact in-file dupes caught by the guard).

## Idempotency & the §2b fuzzy-dedup guard

Re-running the seed **never duplicates**. For each venue, in order:

1. exact match on `lower(name) + lower(address)` over verified spots → UPDATE;
2. fuzzy match via `src/lib/fuzzy.ts`: canonical-name similarity ≥ 0.87
   (punctuation/articles/case stripped, Levenshtein) **AND** within 200 m
   (haversine) → UPDATE (coords/category/radius refreshed; existing address is
   never blanked);
3. no match → INSERT.

The 200 m radius keeps same-brand branches (Starbucks #472 vs #1093) distinct
while collapsing node/way duplicates of the same place. `src/lib/fuzzy.ts` is
shared with the spot-creation route (spec §2b: duplicate custom-spot creation
is prevented by the same fuzzy match — wired into `POST /api/v1/spots`).

## Reaching the full ~1,000 (expansion path)

806 real venues is the honest yield of the current curation (every remaining
OSM POI in Tempe either has no name, is disused/private, is outside city
limits, or is a duplicate). To top up, add Overpass dumps from adjacent
categories and re-run the generator, then re-seed (dedup makes this safe):

```bash
bun server/seed/gen-from-overpass.ts /tmp/<newquery>.json >> # merge & regen
```

Candidate categories for a future pass:named retail/dining inside Tempe
Marketplace & AZ Mills tenancy lists, additional ASU recreation/cultural
buildings, named bus/metro-adjacent hangouts. The venue-count test in
`test/venue-seed.test.ts` (≥ 600) documents the floor.

## API

`GET /api/v1/venues` (slice 2) — public search over verified POI spots:
`q`, `category`, `page`, `limit` (≤ 100), optional `lat`/`lon`/`radius_m`
radius search. Returns `{ venues, page, limit, total, total_pages }`.
Distinct from `GET /api/v1/spots` (slice 1), which applies the custom-spot
masking rules over the full spot table.
