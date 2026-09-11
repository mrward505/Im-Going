/**
 * REVAMP 4 live tests (LIVE=1, real Postgres + booted app) — the new
 * social-atmosphere fields must come from REAL Going/Event rows:
 *   1. /api/v1/venues/search rows carry going_now/heat_count/heat_level
 *      (zero for quiet spots, real numbers once someone is going).
 *   2. /api/v1/spots/:id carries top_goer = highest-star ACTIVE goer on the
 *      next event (excluding nothing for anonymous viewers), null when no
 *      one else is going.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import type { FastifyInstance } from "fastify";
let BASE = process.env.TEST_API_URL ?? "http://127.0.0.1:8080";
const skip = process.env.LIVE !== "1";
async function jfetch(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(BASE + path);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
let app: FastifyInstance | undefined;
async function boot(): Promise<void> {
  if (process.env.LIVE !== "1") return;
  const { buildApp } = await import("../src/index");
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  BASE = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
}
const TAG = `R4${Date.now() % 1e6}`;
let liveSpot = "";
let quietSpot = "";
describe("revamp 4 live: going-now + heat on search rows, top_goer on detail", () => {
  beforeAll(async () => {
    await boot();
    if (skip) return;
    const { getPool } = await import("../src/db/pool");
    const pool = getPool();
    // One live spot (event starts in 1 h, one active goer, 5★).
    const s = await pool.query<{ id: string }>(
      `INSERT INTO spots (name, address, lat, lon, geofence_radius_m, category, is_verified, city)
       VALUES ($1, '1 Test Way, Tempe, AZ', 33.4242, -111.9281, 150, 'bar', true, 'Tempe') RETURNING id`,
      [`${TAG} Live Rooftop`],
    );
    liveSpot = s.rows[0].id;
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (phone, dob, display_name, username, city, star_rating)
       VALUES ($1, '2000-01-01', $2, $3, 'Tempe', 5.0) RETURNING id`,
      [`+1${String(6020000000 + (Date.now() % 999999))}`, `${TAG} Star`, `r4star_${TAG}`.slice(0, 20)],
    );
    const e = await pool.query<{ id: string }>(
      `INSERT INTO events (spot_id, start_at, note) VALUES ($1, now() + interval '1 hour', 'r4-test') RETURNING id`,
      [liveSpot],
    );
    await pool.query(`INSERT INTO going (event_id, user_id, status) VALUES ($1, $2, 'active')`, [e.rows[0].id, u.rows[0].id]);
    const q = await pool.query<{ id: string }>(
      `INSERT INTO spots (name, address, lat, lon, geofence_radius_m, category, is_verified, city)
       VALUES ($1, '2 Test Way, Mesa, AZ', 33.4152, -111.8315, 150, 'restaurant', true, 'Mesa') RETURNING id`,
      [`${TAG} Quiet Corner`],
    );
    quietSpot = q.rows[0].id;
  });
  test("search rows carry real going_now/heat fields; quiet spots report zeros", async () => {
    if (skip) return;
    const live = await jfetch(`/api/v1/venues/search?q=${encodeURIComponent(TAG + " Live")}`);
    expect(live.status).toBe(200);
    const liveVenue = (live.body.venues as Record<string, unknown>[])[0];
    expect(liveVenue).toBeTruthy();
    expect(typeof liveVenue.going_now).toBe("number");
    expect(typeof liveVenue.heat_count).toBe("number");
    expect([0, 1, 2, 3]).toContain(liveVenue.heat_level as number);
    expect(liveVenue.going_count).toBeGreaterThan(0);
    void liveSpot;
    const quiet = await jfetch(`/api/v1/venues/search?q=${encodeURIComponent(TAG + " Quiet")}`);
    const quietVenue = (quiet.body.venues as Record<string, unknown>[])[0];
    expect(quietVenue.going_count).toBe(0);
    expect(quietVenue.going_now).toBe(0);
    expect(quietVenue.heat_count).toBe(0);
    expect(quietVenue.heat_level).toBe(0);
  });
  test("spot detail top_goer = highest-star active goer on the next event", async () => {
    if (skip) return;
    const r = await jfetch(`/api/v1/spots/${liveSpot}`);
    expect(r.status).toBe(200);
    const tg = r.body.top_goer as { display_name: string; star_rating: number } | null;
    expect(tg).toBeTruthy();
    expect(tg?.display_name).toContain(TAG);
    expect(tg?.star_rating).toBe(5);
    const quiet = await jfetch(`/api/v1/spots/${quietSpot}`);
    expect((quiet.body.top_goer as unknown) ?? null).toBeNull();
  });
});