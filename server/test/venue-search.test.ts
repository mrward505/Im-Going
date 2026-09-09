/**
 * Revamp 1 tests — universal metro search + cities list (LIVE=1, real
 * Postgres + booted app). All live-signal assertions use REAL Going/Event
 * rows created in-test; zeros are asserted where no activity exists.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import type { FastifyInstance } from "fastify";

let BASE = process.env.TEST_API_URL ?? "http://127.0.0.1:8080";
const skip = process.env.LIVE !== "1";

async function jfetch(path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const hasBody = init.body !== undefined && init.body !== null;
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = { _raw: await res.text() };
  }
  return { status: res.status, body };
}

let app: FastifyInstance | undefined;
async function boot(): Promise<void> {
  if (process.env.LIVE !== "1") return;
  const { buildApp } = await import("../src/index");
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  BASE = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
}

const TAG = `MSRCH${Date.now() % 1e6}`;

async function insertSpot(name: string, city: string, category: string, lat: number, lon: number): Promise<string> {
  const { getPool } = await import("../src/db/pool");
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO spots (name, address, lat, lon, geofence_radius_m, category, is_verified, city)
     VALUES ($1, $2, $3, $4, 150, $5, true, $6) RETURNING id`,
    [name, `1 ${name} Way, ${city}, AZ`, lat, lon, category, city],
  );
  return rows[0].id;
}

async function insertUser(): Promise<string> {
  const { getPool } = await import("../src/db/pool");
  const suffix = `${Date.now() % 1e9}${Math.floor(Math.random() * 1e5)}`;
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO users (phone, dob, display_name, username, city)
     VALUES ($1, '2000-01-01', $2, $3, 'Tempe') RETURNING id`,
    [`+1${String(5550000000 + Math.floor(Math.random() * 999999))}${suffix.slice(-1)}`.slice(0, 12), `Searcher ${suffix}`, `msrch_${suffix}`.slice(0, 20)],
  );
  return rows[0].id;
}

/** Verified spot + live event (starts in 1 h) + one active going. */
async function insertLiveSpot(name: string, city: string, category: string, lat: number, lon: number): Promise<string> {
  const { getPool } = await import("../src/db/pool");
  const pool = getPool();
  const spotId = await insertSpot(name, city, category, lat, lon);
  const e = await pool.query<{ id: string }>(
    `INSERT INTO events (spot_id, start_at, note) VALUES ($1, now() + interval '1 hour', 'search-test') RETURNING id`,
    [spotId],
  );
  const userId = await insertUser();
  await pool.query(`INSERT INTO going (event_id, user_id, status) VALUES ($1, $2, 'active')`, [e.rows[0].id, userId]);
  return spotId;
}

let scottsdaleBar = "";
let phoenixClub = "";
let quietCafe = "";

describe("revamp 1 live: universal venue search + cities", () => {
  beforeAll(async () => {
    await boot();
    if (skip) return;
    scottsdaleBar = await insertLiveSpot(`${TAG} Old Town Pour House`, "Scottsdale", "bar", 33.4943, -111.9260);
    phoenixClub = await insertLiveSpot(`${TAG} Roosevelt Row Club`, "Phoenix", "club", 33.4519, -112.0682);
    quietCafe = await insertSpot(`${TAG} Quiet Corner Cafe`, "Mesa", "restaurant", 33.4152, -111.8315);
    void scottsdaleBar;
    void phoenixClub;
  });

  test("name match returns the venue with map-ready fields + real going signal", async () => {
    if (skip) return;
    const r = await jfetch(`/api/v1/venues/search?q=${encodeURIComponent(TAG + " Old Town")}`);
    expect(r.status).toBe(200);
    const venues = r.body.venues as Record<string, unknown>[];
    expect(venues.length).toBe(1);
    const v = venues[0];
    expect(v.city).toBe("Scottsdale");
    expect(v.category).toBe("bar");
    expect(typeof v.lat).toBe("number");
    expect(typeof v.lon).toBe("number");
    expect(v.going_count).toBe(1); // one real going row, nothing invented
    expect(v.trending_score).toBe(1);
  });

  test("city filter scopes to that city only", async () => {
    if (skip) return;
    const r = await jfetch(`/api/v1/venues/search?q=${TAG}&city=Phoenix`);
    expect(r.status).toBe(200);
    const venues = r.body.venues as Record<string, unknown>[];
    expect(venues.length).toBe(1);
    expect((venues[0].name as string)).toContain("Roosevelt");
  });

  test("category filter scopes to that category only", async () => {
    if (skip) return;
    const r = await jfetch(`/api/v1/venues/search?q=${TAG}&category=club`);
    expect(r.status).toBe(200);
    const venues = r.body.venues as Record<string, unknown>[];
    expect(venues.length).toBe(1);
    expect(venues[0].category).toBe("club");
  });

  test("empty results for unknown query and unknown city", async () => {
    if (skip) return;
    const r1 = await jfetch(`/api/v1/venues/search?q=${TAG}ZZZNoSuchPlace`);
    expect(r1.status).toBe(200);
    expect((r1.body.venues as unknown[]).length).toBe(0);
    expect(r1.body.total).toBe(0);
    const r2 = await jfetch(`/api/v1/venues/search?q=${TAG}&city=Atlantis`);
    expect(r2.status).toBe(200);
    expect((r2.body.venues as unknown[]).length).toBe(0);
  });

  test("sort=name is alphabetical; sort=going puts live venues first and is stable", async () => {
    if (skip) return;
    const byName = await jfetch(`/api/v1/venues/search?q=${TAG}&sort=name`);
    expect(byName.status).toBe(200);
    const names = (byName.body.venues as Record<string, unknown>[]).map((v) => v.name as string);
    expect(names).toEqual([...names].sort());
    const byGoing = await jfetch(`/api/v1/venues/search?q=${TAG}&sort=going`);
    expect(byGoing.status).toBe(200);
    const g = byGoing.body.venues as Record<string, unknown>[];
    expect(g.length).toBe(3);
    // quiet cafe has no live events → going_count 0 sinks to the bottom
    expect(g[g.length - 1].name).toContain("Quiet Corner");
    expect(g[g.length - 1].going_count).toBe(0);
    // the two live venues tie at 1 → stable alphabetical tiebreak
    expect(g[0].going_count).toBe(1);
    expect(g[1].going_count).toBe(1);
    expect((g[0].name as string) < (g[1].name as string)).toBe(true);
    const byTrending = await jfetch(`/api/v1/venues/search?q=${TAG}&sort=trending`);
    expect(byTrending.status).toBe(200);
    expect((byTrending.body.venues as Record<string, unknown>[]).map((v) => v.name)).toEqual(
      g.map((v) => v.name),
    );
  });

  test("geosearch bounds: nearby venue in, far venue out", async () => {
    if (skip) return;
    // Center on Old Town Scottsdale, 2 km radius: Scottsdale bar in, Phoenix + Mesa out.
    const r = await jfetch(
      `/api/v1/venues/search?q=${TAG}&lat=33.4943&lon=-111.9260&radius_km=2`,
    );
    expect(r.status).toBe(200);
    const venues = r.body.venues as Record<string, unknown>[];
    expect(venues.length).toBe(1);
    expect(venues[0].city).toBe("Scottsdale");
    // Wide radius catches all three.
    const r2 = await jfetch(
      `/api/v1/venues/search?q=${TAG}&lat=33.45&lon=-111.95&radius_km=40`,
    );
    expect(r2.status).toBe(200);
    expect((r2.body.venues as unknown[]).length).toBe(3);
  });

  test("lat without lon is a 400", async () => {
    if (skip) return;
    const r = await jfetch(`/api/v1/venues/search?q=${TAG}&lat=33.45`);
    expect(r.status).toBe(400);
  });

  test("cities endpoint lists real cities with counts", async () => {
    if (skip) return;
    const r = await jfetch(`/api/v1/cities`);
    expect(r.status).toBe(200);
    const cities = r.body.cities as { city: string; venue_count: number }[];
    expect(cities.length).toBeGreaterThanOrEqual(3);
    const names = cities.map((c) => c.city);
    for (const c of ["Scottsdale", "Phoenix", "Mesa"]) expect(names).toContain(c);
    for (const c of cities) expect(c.venue_count).toBeGreaterThan(0);
  });
});
