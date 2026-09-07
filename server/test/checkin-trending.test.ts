/**
 * Slice 3 live tests (LIVE=1, real Postgres + booted app): check-in/geofence,
 * settlement runner, trending endpoint, share rate-limit, cancel ledger writes.
 *
 * Time control: event windows are server-clock driven, so tests create events
 * with start_at inside the check-in window (now − 10 min → window open) or
 * already elapsed (now − 3 h → window closed). Events are inserted directly
 * via SQL to bypass the API's "start ≥ 30 min out" announce guard.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
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

let seq = 0;
async function newUser(prefix: string): Promise<{ token: string; id: string }> {
  seq += 1;
  const phone = `+1999${String(1000000 + seq).padStart(7, "0")}${String(Math.floor(Math.random() * 1e6)).padStart(6, "0").slice(0, 3)}${String(Date.now() % 1000).padStart(3, "0")}`.slice(0, 12);
  const req = await jfetch("/api/v1/auth/otp/request", { method: "POST", body: JSON.stringify({ phone }) });
  if (req.status !== 201) throw new Error(`otp request failed: ${JSON.stringify(req.body)}`);
  const ver = await jfetch("/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ phone, code: req.body.dev_code as string }),
  });
  const uname = `${prefix}${seq}${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 18);
  const reg = await jfetch("/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({
      signup_token: ver.body.signup_token,
      display_name: `${prefix} ${seq}`,
      username: uname,
      dob: "2000-01-01",
    }),
  });
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  return { token: reg.body.token as string, id: (reg.body.user as Record<string, unknown>).id as string };
}

async function authz(token: string): Promise<Record<string, string>> {
  return { authorization: `Bearer ${token}` };
}

/** Insert a verified spot + event directly (bypasses the announce time guard). */
async function seedEvent(startOffsetMin: number): Promise<{ spotId: string; eventId: string; lat: number; lon: number }> {
  const { getPool } = await import("../src/db/pool");
  const pool = getPool();
  const lat = 33.42;
  const lon = -111.93;
  const s = await pool.query<{ id: string }>(
    `INSERT INTO spots (name, address, lat, lon, geofence_radius_m, category, is_verified, city)
     VALUES ($1, $2, $3, $4, 150, 'bar', true, 'Tempe') RETURNING id`,
    [`Slice3 Spot ${Date.now() % 1e7}-${Math.floor(Math.random() * 1e5)}`, "1 Test Way", lat, lon],
  );
  const e = await pool.query<{ id: string }>(
    `INSERT INTO events (spot_id, start_at, note) VALUES ($1, now() + ($2 || ' minutes')::interval, 'slice3') RETURNING id`,
    [s.rows[0].id, String(startOffsetMin)],
  );
  return { spotId: s.rows[0].id, eventId: e.rows[0].id, lat, lon };
}

async function confirm(token: string, eventId: string): Promise<void> {
  const r = await jfetch(`/api/v1/events/${eventId}/going`, {
    method: "POST",
    headers: await authz(token),
    body: JSON.stringify({}),
  });
  if (r.status !== 201) throw new Error(`confirm failed: ${r.status} ${JSON.stringify(r.body)}`);
}

describe("slice 3 live: check-in + settlement + trending + shares", () => {
  beforeAll(async () => {
    await boot();
    if (skip) return;
    const { getPool } = await import("../src/db/pool");
    const path = new URL("./fixtures/live.sql", import.meta.url).pathname;
    await getPool().query(readFileSync(path, "utf8"));
  });

  test("boot registers the new routes", async () => {
    if (skip) return;
    const t = await jfetch("/api/v1/trending");
    expect(t.status).toBe(200);
    expect(Array.isArray(t.body.trending)).toBe(true);
  });

  test("manual check-in inside window+geofence verifies; +100 show-up", async () => {
    if (skip) return;
    const u = await newUser("checkin");
    const { eventId, lat, lon } = await seedEvent(-10); // started 10 min ago → window open
    await confirm(u.token, eventId);
    const ci = await jfetch(`/api/v1/events/${eventId}/checkin`, {
      method: "POST",
      headers: await authz(u.token),
      body: JSON.stringify({ lat, lon, method: "manual_gps" }),
    });
    expect(ci.status).toBe(201);
    const settlement = ci.body.settlement as Record<string, unknown>;
    expect(settlement.kind).toBe("showup");
    expect(settlement.points_delta).toBe(100);
    expect(settlement.reputation_points).toBe(600);
    expect(ci.body.first_verified_checkin).toBe(true);
    // /me reflects the new cache
    const me = await jfetch("/api/v1/me", { headers: await authz(u.token) });
    expect((me.body.user as Record<string, unknown>).reputation_points).toBe(600);
    // duplicate check-in → 409 (one per user+event)
    const dup = await jfetch(`/api/v1/events/${eventId}/checkin`, {
      method: "POST",
      headers: await authz(u.token),
      body: JSON.stringify({ lat, lon }),
    });
    expect(dup.status).toBe(409);
  });

  test("outside-geofence check-in is rejected (403), no credit", async () => {
    if (skip) return;
    const u = await newUser("faraway");
    const { eventId, lat, lon } = await seedEvent(-10);
    await confirm(u.token, eventId);
    const ci = await jfetch(`/api/v1/events/${eventId}/checkin`, {
      method: "POST",
      headers: await authz(u.token),
      body: JSON.stringify({ lat: lat + 0.05, lon, method: "manual_gps" }), // ~5.5 km away
    });
    expect(ci.status).toBe(403);
    const me = await jfetch("/api/v1/me", { headers: await authz(u.token) });
    expect((me.body.user as Record<string, unknown>).reputation_points).toBe(500);
  });

  test("spoof guard: >300 km/h implied move is rejected", async () => {
    if (skip) return;
    const u = await newUser("spoofer");
    const a = await seedEvent(-10);
    await confirm(u.token, a.eventId);
    const ok = await jfetch(`/api/v1/events/${a.eventId}/checkin`, {
      method: "POST",
      headers: await authz(u.token),
      body: JSON.stringify({ lat: a.lat, lon: a.lon }),
    });
    expect(ok.status).toBe(201);
    // Second event, far away, immediately: ~110 km in seconds → implausible.
    const { getPool } = await import("../src/db/pool");
    const pool = getPool();
    const s = await pool.query<{ id: string }>(
      `INSERT INTO spots (name, lat, lon, geofence_radius_m, category, is_verified, city)
       VALUES ('Far Spot', 34.42, -111.93, 150, 'bar', true, 'Tempe') RETURNING id`,
    );
    const e = await pool.query<{ id: string }>(
      `INSERT INTO events (spot_id, start_at) VALUES ($1, now() - interval '10 minutes') RETURNING id`,
      [s.rows[0].id],
    );
    await confirm(u.token, e.rows[0].id);
    const bad = await jfetch(`/api/v1/events/${e.rows[0].id}/checkin`, {
      method: "POST",
      headers: await authz(u.token),
      body: JSON.stringify({ lat: 34.42, lon: -111.93 }),
    });
    expect(bad.status).toBe(403);
  });

  test("settlement: permission granted + no check-in → no-show −60; no permission → unverifiable 0", async () => {
    if (skip) return;
    const { getPool } = await import("../src/db/pool");
    const pool = getPool();
    const elapsed = await seedEvent(-200); // window closed (start 200 min ago)
    const uNo = await newUser("noshow");
    const uUn = await newUser("unverif");
    await confirm(uNo.token, elapsed.eventId);
    await confirm(uUn.token, elapsed.eventId);
    // uNo "granted permission" (simulate an outside-geofence fix attempt is
    // overkill; flip the cached flag the way a real fix would).
    await pool.query("UPDATE users SET location_permission_granted = true WHERE id = $1", [uNo.id]);
    const runner = await newUser("runner");
    const run = await jfetch("/api/v1/settlement/run", {
      method: "POST",
      headers: await authz(runner.token),
      body: JSON.stringify({}),
    });
    expect(run.status).toBe(200);
    const meNo = await jfetch("/api/v1/me", { headers: await authz(uNo.token) });
    expect((meNo.body.user as Record<string, unknown>).reputation_points).toBe(440);
    const meUn = await jfetch("/api/v1/me", { headers: await authz(uUn.token) });
    expect((meUn.body.user as Record<string, unknown>).reputation_points).toBe(500);
    // ledger has the no-show row, nothing for unverifiable
    const led = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM reputation_ledger WHERE user_id = $1 AND kind = 'no_show'",
      [uNo.id],
    );
    expect(led.rows[0].n).toBe(1);
    const ledUn = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM reputation_ledger WHERE user_id = $1",
      [uUn.id],
    );
    expect(ledUn.rows[0].n).toBe(0);
    // re-run is idempotent: no second ledger row
    await jfetch("/api/v1/settlement/run", {
      method: "POST",
      headers: await authz(runner.token),
      body: JSON.stringify({}),
    });
    const led2 = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM reputation_ledger WHERE user_id = $1 AND kind = 'no_show'",
      [uNo.id],
    );
    expect(led2.rows[0].n).toBe(1);
  });

  test("cancel < 2 h before start writes soft no-show −30", async () => {
    if (skip) return;
    const { getPool } = await import("../src/db/pool");
    const pool = getPool();
    const u = await newUser("latecancel");
    // event starting in 60 min: announce via API (≥30 min out passes the guard).
    // NOTE: must use a dedicated fresh spot (not `LIMIT 1` over verified spots):
    // announce day-snaps to any active same-day event on the spot, and the
    // fixture's 'The 44' has one at now()+3h — snapping to it would make the
    // cancel compute free_cancel instead of soft_no_show.
    const fresh = await pool.query<{ id: string }>(
      `INSERT INTO spots (name, lat, lon, geofence_radius_m, category, is_verified, city)
       VALUES ('Late Cancel Spot', 33.42, -111.93, 150, 'bar', true, 'Tempe') RETURNING id`,
    );
    const spotId = fresh.rows[0].id;
    const startAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const ev = await jfetch("/api/v1/events", {
      method: "POST",
      headers: await authz(u.token),
      body: JSON.stringify({ spot_id: spotId, start_at: startAt }),
    });
    expect(ev.status).toBe(201);
    const eventId = (ev.body.event as Record<string, unknown>).id as string;
    const cancel = await jfetch(`/api/v1/events/${eventId}/going`, {
      method: "DELETE",
      headers: await authz(u.token),
    });
    expect(cancel.status).toBe(200);
    expect(cancel.body.settlement).toBe("soft_no_show");
    expect(cancel.body.points_delta).toBe(-30);
    const me = await jfetch("/api/v1/me", { headers: await authz(u.token) });
    expect((me.body.user as Record<string, unknown>).reputation_points).toBe(470);
  });

  test("cancel ≥ 2 h before start is free (0, no ledger row)", async () => {
    if (skip) return;
    const { getPool } = await import("../src/db/pool");
    const pool = getPool();
    const u = await newUser("freecancel");
    // shape a fixture event to start in 5 h (window not open, free-cancel zone)
    const ev2 = await seedEvent(300);
    await confirm(u.token, ev2.eventId);
    const cancel = await jfetch(`/api/v1/events/${ev2.eventId}/going`, {
      method: "DELETE",
      headers: await authz(u.token),
    });
    expect(cancel.status).toBe(200);
    expect(cancel.body.settlement).toBe("free_cancel");
    const me = await jfetch("/api/v1/me", { headers: await authz(u.token) });
    expect((me.body.user as Record<string, unknown>).reputation_points).toBe(500);
    const led = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM reputation_ledger WHERE user_id = $1",
      [u.id],
    );
    expect(led.rows[0].n).toBe(0);
  });

  test("trending endpoint: 48 h window, weights, ≥1 Going, limit 20", async () => {
    if (skip) return;
    const u = await newUser("trend");
    const soon = await seedEvent(60); // +1 h → inside 48 h
    await confirm(u.token, soon.eventId);
    const far = await seedEvent(60 * 50); // +50 h → outside
    await confirm(u.token, far.eventId);
    const t = await jfetch("/api/v1/trending", { headers: await authz(u.token) });
    expect(t.status).toBe(200);
    const rows = t.body.trending as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(20);
    const ids = rows.map((r) => (r.spot as Record<string, unknown>).id ?? r.spot_id);
    const { getPool } = await import("../src/db/pool");
    const soonSpot = await getPool().query<{ spot_id: string }>("SELECT spot_id FROM events WHERE id = $1", [soon.eventId]);
    const farSpot = await getPool().query<{ spot_id: string }>("SELECT spot_id FROM events WHERE id = $1", [far.eventId]);
    expect(ids).toContain(soonSpot.rows[0].spot_id);
    expect(ids).not.toContain(farSpot.rows[0].spot_id);
    // score math: fresh 3.0★ contribution = 1.0 (no verified check-in → stale ×0.5 → 0.5)
    const row = rows.find((r) => ((r.spot as Record<string, unknown>).id ?? r.spot_id) === soonSpot.rows[0].spot_id);
    expect(Number(row?.trending_score)).toBeCloseTo(0.5, 5);
  });

  test("share rate-limit: 10/day, then 429; budget reports remainder", async () => {
    if (skip) return;
    const u = await newUser("sharer");
    const h = await authz(u.token);
    const b0 = await jfetch("/api/v1/shares/budget", { headers: h });
    expect(b0.body.remaining).toBe(10);
    for (let i = 0; i < 10; i++) {
      const s = await jfetch("/api/v1/shares", {
        method: "POST",
        headers: h,
        body: JSON.stringify({ channel: "test" }),
      });
      expect(s.status).toBe(201);
      expect(s.body.remaining).toBe(9 - i);
    }
    const over = await jfetch("/api/v1/shares", {
      method: "POST",
      headers: h,
      body: JSON.stringify({ channel: "test" }),
    });
    expect(over.status).toBe(429);
    const b1 = await jfetch("/api/v1/shares/budget", { headers: h });
    expect(b1.body.remaining).toBe(0);
  });

  test("spot detail: verified spot returns card + next event + going count", async () => {
    if (skip) return;
    const u = await newUser("spotdet");
    const h = await authz(u.token);
    const soon = await seedEvent(60); // +1 h → upcoming
    await confirm(u.token, soon.eventId);
    const d = await jfetch(`/api/v1/spots/${soon.spotId}`, { headers: h });
    expect(d.status).toBe(200);
    const spot = d.body.spot as Record<string, unknown>;
    expect(typeof spot.name).toBe("string");
    expect(spot.category).toBe("bar");
    expect(spot.is_verified).toBe(true);
    expect(spot.address).toBe("1 Test Way");
    const next = d.body.next_event as Record<string, unknown>;
    expect(next.id).toBe(soon.eventId);
    expect(typeof next.start_at).toBe("string");
    expect(d.body.going_count).toBe(1);
    expect(d.body.my_going).toBe(true);
  });

  test("spot detail: custom spot masks address until confirmed", async () => {
    if (skip) return;
    const creator = await newUser("maskmk");
    const stranger = await newUser("maskst");
    const hc = await authz(creator.token);
    const hs = await authz(stranger.token);
    const cs = await jfetch("/api/v1/spots", {
      method: "POST",
      headers: hc,
      body: JSON.stringify({ name: `Mask House ${Date.now() % 1e7}`, address: "999 Secret Ln", lat: 33.42, lon: -111.93, category: "house" }),
    });
    expect(cs.status).toBe(201);
    const spotId = (cs.body.spot as Record<string, unknown>).id as string;
    // stranger (no going): masked
    const anon = await jfetch(`/api/v1/spots/${spotId}`, { headers: hs });
    expect(anon.status).toBe(200);
    const masked = anon.body.spot as Record<string, unknown>;
    expect(masked.address).toBeNull();
    expect(masked.masked_address).toBe("Private spot in Tempe");
    expect("lat" in (masked as object)).toBe(false);
    expect(anon.body.my_going).toBe(false);
    // creator: unmasked
    const own = await jfetch(`/api/v1/spots/${spotId}`, { headers: hc });
    expect((own.body.spot as Record<string, unknown>).address).toBe("999 Secret Ln");
  });

  test("spot share: snapshot payload + budget + 429 at exhaustion + 404", async () => {
    if (skip) return;
    const u = await newUser("spotshr");
    const h = await authz(u.token);
    const soon = await seedEvent(60);
    await confirm(u.token, soon.eventId);
    const s = await jfetch(`/api/v1/spots/${soon.spotId}/share`, { headers: h });
    expect(s.status).toBe(200);
    const card = s.body.card as Record<string, unknown>;
    expect(typeof card.spot_name).toBe("string");
    expect(card.category).toBe("bar");
    expect(card.address).toBe("1 Test Way");
    expect(card.masked_address).toBeNull();
    expect(card.is_verified).toBe(true);
    expect(typeof card.next_start_at).toBe("string");
    expect(card.going_count).toBe(1);
    expect(card.creator_display_name).toBeNull(); // seeded spot, no creator
    const share = s.body.share as Record<string, unknown>;
    expect(share.limit).toBe(10);
    expect(share.remaining).toBe(10);
    expect(share.deep_link).toBe(`https://imgoing.live/s/${soon.spotId}`);
    // exhaust the budget via POST /shares → snapshot now 429s (same gate)
    for (let i = 0; i < 10; i++) {
      await jfetch("/api/v1/shares", { method: "POST", headers: h, body: JSON.stringify({}) });
    }
    const gated = await jfetch(`/api/v1/spots/${soon.spotId}/share`, { headers: h });
    expect(gated.status).toBe(429);
    expect((gated.body.error as Record<string, unknown>).code).toBe("rate_limited");
    // unknown id → 404 even with budget elsewhere (fresh user)
    const fresh = await newUser("spot404");
    const nf = await jfetch("/api/v1/spots/00000000-0000-0000-0000-000000000000/share", {
      headers: await authz(fresh.token),
    });
    expect(nf.status).toBe(404);
  });

  test("ledger is append-only (UPDATE/DELETE rejected)", async () => {
    if (skip) return;
    const { getPool } = await import("../src/db/pool");
    const pool = getPool();
    // Touch a REAL row: row-level triggers never fire on zero-row statements
    // (so `... WHERE false` would vacuously "pass"). Insert a throwaway user
    // + ledger row, then prove UPDATE and DELETE both raise.
    const u = await pool.query<{ id: string }>(
      `INSERT INTO users (phone, dob, display_name, username) VALUES ($1, '2000-01-01', 'Ledger', $2) RETURNING id`,
      [`+1888${String(Math.floor(1000000 + Math.random() * 8999999))}`, `ledger${seq}${Math.floor(Math.random() * 1e6).toString(36)}`],
    );
    const uid = u.rows[0].id;
    const led = await pool.query<{ id: string }>(
      "INSERT INTO reputation_ledger (user_id, kind, points_delta) VALUES ($1, 'admin_adjust', 0) RETURNING id",
      [uid],
    );
    const lid = led.rows[0].id;
    let updateThrew = false;
    try {
      await pool.query("UPDATE reputation_ledger SET points_delta = 1 WHERE id = $1", [lid]);
    } catch {
      updateThrew = true;
    }
    expect(updateThrew).toBe(true);
    let deleteThrew = false;
    try {
      await pool.query("DELETE FROM reputation_ledger WHERE id = $1", [lid]);
    } catch {
      deleteThrew = true;
    }
    expect(deleteThrew).toBe(true);
    // ...and the row is untouched.
    const still = await pool.query<{ points_delta: number }>(
      "SELECT points_delta FROM reputation_ledger WHERE id = $1",
      [lid],
    );
    expect(still.rows[0].points_delta).toBe(0);
  });
});
