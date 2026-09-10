import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool";

/**
 * Venue discovery (slices 2 + revamp 1).
 *
 * GET /api/v1/venues — legacy single-city list over VERIFIED (POI-seeded)
 * spots (Tempe default; kept for the shipped TestFlight client).
 *
 * GET /api/v1/venues/search — UNIVERSAL metro search across all seeded
 * cities (Tempe, Scottsdale, Chandler, Phoenix, Mesa, Gilbert, Glendale):
 *   - q          optional name/address substring (ILIKE)
 *   - city       optional exact city filter (case-insensitive)
 *   - category   optional enum filter (bar|club|concert|restaurant|house|other)
 *   - lat/lon/radius_km  optional geosearch (radius_km default 25, max 100;
 *              lat+lon must come together)
 *   - sort       name | trending | going (default name)
 *   - page/limit pagination (limit ≤ 100, page ≥ 1)
 *
 * Live signals (going_count, trending_score) come ONLY from real Going/Event
 * rows — never fabricated. A venue with no live events reports zeros.
 * Every row carries lat/lon/city/category so the map view (next delegation)
 * can pin it with no extra fetch.
 *
 * GET /api/v1/cities — the real metro city list with verified-venue counts,
 * derived from seeded data (no hardcoded list to rot).
 */
const querySchema = z.object({
  q: z.string().min(1).max(120).optional(),
  category: z.enum(["bar", "club", "concert", "restaurant", "house", "other"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  radius_m: z.coerce.number().int().min(50).max(5000).default(1000),
});

const searchQuerySchema = z.object({
  q: z.string().min(1).max(120).optional(),
  city: z.string().min(1).max(60).optional(),
  category: z.enum(["bar", "club", "concert", "restaurant", "house", "other"]).optional(),
  sort: z.enum(["name", "trending", "going"]).default("name"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  radius_km: z.coerce.number().min(0.05).max(100).default(25),
});

// Active goings on live events (not yet ended): the ONLY source of "going"
// and "trending" signals. One row per spot.
const LIVE_GOING_SQL = `
  LEFT JOIN (
    SELECT e.spot_id AS spot_id, count(*)::int AS going_count
    FROM going g
    JOIN events e ON e.id = g.event_id
    WHERE g.status = 'active'
      AND e.status = 'active'
      AND e.default_end > now()
    GROUP BY e.spot_id
  ) live ON live.spot_id = s.id
`;

const DISTANCE_SQL = `(6371000 * 2 * asin(sqrt(`
  + `power(sin(radians(lat_p - s.lat) / 2), 2) + `
  + `cos(radians(s.lat)) * cos(radians(lat_p)) * `
  + `power(sin(radians(lon_p - s.lon) / 2), 2)`
  + `)))`;

export async function registerVenueRoutes(app: FastifyInstance): Promise<void> {
  const pool = getPool();

  app.get("/api/v1/venues", async (req, reply) => {
    const q = querySchema.parse(req.query);

    const params: unknown[] = [];
    const where: string[] = [`s.is_verified = true`, `s.city = $1`];
    params.push("Tempe");

    if (q.category) {
      params.push(q.category);
      where.push(`s.category = $${params.length}`);
    }
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(`(s.name ILIKE $${params.length} OR COALESCE(s.address, '') ILIKE $${params.length})`);
    }
    // Radius search (haversine in SQL — PostGIS optional per slice-1 migration).
    if (q.lat !== undefined && q.lon !== undefined) {
      params.push(q.lat, q.lon, q.radius_m);
      const p = params.length;
      where.push(
        `(6371000 * 2 * asin(sqrt(`
        + `power(sin(radians($${p - 2} - s.lat) / 2), 2) + `
        + `cos(radians(s.lat)) * cos(radians($${p - 2})) * `
        + `power(sin(radians($${p - 1} - s.lon) / 2), 2)`
        + `)) < $${p})`,
      );
    }

    const limit = q.limit;
    const offset = (q.page - 1) * limit;
    // LIMIT/OFFSET are engine-validated ints via zod (not identifier-safe SQL),
    // so they are inlined with Number.isInteger guards rather than bound params.
    if (!Number.isInteger(limit) || !Number.isInteger(offset) || limit < 1 || offset < 0) {
      return reply.code(400).send({ error: { code: "bad_request", message: "invalid pagination" } });
    }

    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.address, s.lat, s.lon, s.geofence_radius_m, s.category,
              s.is_large_venue, s.city
       FROM spots s
       WHERE ${where.join(" AND ")}
       ORDER BY s.name
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    // Total for the same filters (without pagination) so the client can page.
    const { rows: totalRows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM spots s WHERE ${where.join(" AND ")}`,
      params,
    );

    return reply.send({
      venues: rows,
      page: q.page,
      limit,
      total: totalRows[0]?.n ?? 0,
      total_pages: Math.max(1, Math.ceil((totalRows[0]?.n ?? 0) / limit)),
    });
  });

  app.get("/api/v1/venues/search", async (req, reply) => {
    const q = searchQuerySchema.parse(req.query);
    if ((q.lat === undefined) !== (q.lon === undefined)) {
      return reply.code(400).send({
        error: { code: "bad_request", message: "lat and lon must be provided together" },
      });
    }

    const params: unknown[] = [];
    const where: string[] = [`s.is_verified = true`];

    if (q.city) {
      params.push(q.city);
      where.push(`s.city ILIKE $${params.length}`);
    }
    if (q.category) {
      params.push(q.category);
      where.push(`s.category = $${params.length}`);
    }
    if (q.q) {
      params.push(`%${q.q}%`);
      where.push(`(s.name ILIKE $${params.length} OR COALESCE(s.address, '') ILIKE $${params.length})`);
    }
    let distanceSelect = `NULL AS distance_m`;
    if (q.lat !== undefined && q.lon !== undefined) {
      params.push(q.lat, q.lon, q.radius_km * 1000);
      const p = params.length; // p-2 = lat, p-1 = lon, p = radius_m
      const dist = DISTANCE_SQL.replaceAll("lat_p", `$${p - 2}`).replaceAll("lon_p", `$${p - 1}`);
      distanceSelect = `${dist} AS distance_m`;
      where.push(`${dist} < $${p}`);
    }

    const orderBy = q.sort === "name"
      ? `s.name ASC, s.id ASC`
      : `COALESCE(live.going_count, 0) DESC, s.name ASC, s.id ASC`;

    const limit = q.limit;
    const offset = (q.page - 1) * limit;
    if (!Number.isInteger(limit) || !Number.isInteger(offset) || limit < 1 || offset < 0) {
      return reply.code(400).send({ error: { code: "bad_request", message: "invalid pagination" } });
    }

    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.address, s.lat, s.lon, s.geofence_radius_m, s.category,
              s.is_large_venue, s.city,
              COALESCE(live.going_count, 0)::int AS going_count,
              COALESCE(live.going_count, 0)::int AS trending_score,
              ${distanceSelect}
       FROM spots s
       ${LIVE_GOING_SQL}
       WHERE ${where.join(" AND ")}
       ORDER BY ${orderBy}
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    const { rows: totalRows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM spots s
       ${q.sort === "name" ? "" : LIVE_GOING_SQL}
       WHERE ${where.join(" AND ")}`,
      // NB: the count query reuses the same WHERE placeholders; the JOIN is
      // only needed for ordering, so it is omitted for sort=name. For
      // sort=going/trending the WHERE contains no live.* refs, so the same
      // params apply either way.
      params,
    );

    return reply.send({
      venues: rows,
      page: q.page,
      limit,
      total: totalRows[0]?.n ?? 0,
      total_pages: Math.max(1, Math.ceil((totalRows[0]?.n ?? 0) / limit)),
      sort: q.sort,
    });
  });

  app.get("/api/v1/cities", async () => {
    const { rows } = await pool.query<{ city: string; venue_count: number }>(
      `SELECT s.city AS city, count(*)::int AS venue_count
       FROM spots s
       WHERE s.is_verified = true
       GROUP BY s.city
       ORDER BY count(*) DESC, s.city ASC`,
    );
    return { cities: rows };
  });
}
