import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool";
import { findSpotById, findUserById, serializeSpotRaw, type SpotRow } from "../db";
import { badRequest, notFound } from "../lib/errors";
import { insideGeofence, radiusFor, haversineMeters, CUSTOM_SPOT_RADIUS_M } from "../lib/geofence";
import { getConfig } from "../env";

const categorySchema = z.enum(["bar", "club", "concert", "restaurant", "house", "other"]);

export const createSpotSchema = z.object({
  name: z.string().min(1).max(120),
  address: z.string().min(1).max(240).optional(),
  // Client sends the dropped pin, but the server derives geofence_radius_m
  // by spot type — the client can never pick its own radius.
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  category: categorySchema,
  is_large_venue: z.boolean().optional().default(false),
  description: z.string().max(280).optional(),
});

const searchSpotsSchema = z.object({
  q: z.string().min(1).max(120).optional(),
  city: z.string().min(1).max(80).default("Tempe"),
  category: categorySchema.optional(),
  limit: z.number().int().min(1).max(100).default(20),
});

export function normalizeCategory(value: string): string {
  return categorySchema.options.includes(value as never) ? value : value.toLowerCase();
}

export async function registerSpotRoutes(app: FastifyInstance): Promise<void> {
  const pool = getPool();

  // --- create a spot (custom/unlisted houses, parties, get-togethers) -----
  app.post("/api/v1/spots", {
    preHandler: app.authenticate,
  }, async (req, reply) => {
    const claims = req.userClaims!;
    const input = createSpotSchema.parse(req.body);
    const category = normalizeCategory(input.category);
    if (category !== input.category) throw badRequest(`category must be one of ${categorySchema.options.join(", ")}`);

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO spots (name, address, lat, lon, geofence_radius_m, category, is_verified, is_large_venue, city, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, false, false, $7, $8)
       RETURNING id`,
      [
        input.name,
        input.address ?? null,
        input.lat,
        input.lon,
        CUSTOM_SPOT_RADIUS_M, // server-derived: custom residential spots are always 100 m
        category,
        getConfig().LAUNCH_CITY,
        claims.sub,
      ],
    );
    const spot = (await findSpotById(pool, rows[0].id)) as SpotRow | undefined;
    if (!spot) throw new Error("spot vanished after insert");
    // Custom spots are created by the confirming user, so they see the pin.
    return reply.code(201).send({ spot: serializeSpotRaw(spot, { confirmed: true }) });
  });

  // --- spot search (POI + custom; custom spots masked for non-confirmers) --
  app.get("/api/v1/spots", async (req, reply) => {
    const q = searchSpotsSchema.parse(req.query);
    const params: unknown[] = [];
    const where: string[] = ["s.city = $1"];
    params.push(q.city);
    if (q.category) {
      where.push(`s.category = $${params.length + 1}`);
      params.push(q.category);
    }
    if (q.q) {
      where.push(`(s.name ILIKE $${params.length + 1} OR COALESCE(s.address, '') ILIKE $${params.length + 2})`);
      params.push(`%${q.q}%`, `%${q.q}%`);
    }
    const { rows: spots } = await pool.query<SpotRow>(
      `SELECT id, name, address, lat, lon, geofence_radius_m, category, is_verified, is_large_venue, city, created_by, created_at
       FROM spots s WHERE ${where.join(" AND ")} ORDER BY s.name LIMIT $${params.length + 1}`,
      [...params, q.limit],
    );
    const viewerId = req.userClaims?.sub ?? null;
    const isCreator = (s: SpotRow) => viewerId !== null && s.created_by === viewerId;
    return reply.send(spots.map((s) => serializeSpotRaw(s, { confirmed: isCreator(s) })));
  });

  // --- geofence helper (radius + inside check) for the iOS client ---------
  app.post("/api/v1/spots/:id/geofence-test", {
    preHandler: app.authenticate,
  }, async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { lat: number; lon: number };
    const spot = await findSpotById(pool, id);
    if (!spot) throw notFound("spot not found");
    const radius = radiusFor(spot);
    return {
      spot_id: id,
      radius_m: radius,
      inside: insideGeofence(spot, body),
      distance_m: Math.round(haversineMeters(spot.lat, spot.lon, body.lat, body.lon) * 100) / 100,
    };
  });
}

// keep findUserById import referenced (used by search when authenticated)
void findUserById;