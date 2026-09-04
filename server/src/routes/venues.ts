import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool";

/**
 * GET /api/v1/venues — public search/list over VERIFIED (POI-seeded) spots.
 *
 * Distinct from GET /api/v1/spots (slice 1), which mixes custom/unverified
 * spots in with masking rules. Venues are the seeded, always-public places:
 *   - q        optional name/address substring (ILIKE)
 *   - category optional enum filter (bar|club|concert|restaurant|house|other)
 *   - page/limit pagination (limit ≤ 100, page ≥ 1)
 *   - lat/lon optional radius search (radius_m, default 1000, ≤ 5000)
 *
 * Ordered by name; stable pagination for the iOS picker.
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
}
