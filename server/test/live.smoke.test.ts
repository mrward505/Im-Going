/**
 * Live API smoke test against a REAL local Postgres + a started app.
 * Prereqs: Postgres running with the dev role/db (scripts/dev-db.sh),
 * migrations applied (bun run migrate), fixture loaded, then:
 *   bun test test/live.smoke.test.ts
 * or just `bun test` (this file is `.skip`d unless LIVE=1).
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";

let BASE = process.env.TEST_API_URL ?? "http://127.0.0.1:8080";
const skip = process.env.LIVE !== "1";

function loadFixture(): string {
  const path = new URL("./fixtures/live.sql", import.meta.url).pathname;
  return readFileSync(path, "utf8");
}

async function jfetch(path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const hasBody = init.body !== undefined && init.body !== null;
  const res = await fetch(BASE + path, {
    ...init,
    // Only set content-type when there is a body: Fastify rejects an empty
    // JSON body ("Body cannot be empty when content-type is set to
    // 'application/json'") for e.g. body-less DELETE requests.
    headers: {
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function mintOne(): Promise<unknown> {
  const mint = await jfetch("/api/v1/admin/invites/mint", { method: "POST", body: JSON.stringify({ count: 1, label: "test" }) });
  if (mint.status !== 201) throw new Error(`invite mint failed: ${JSON.stringify(mint.body)}`);
  return (mint.body.codes as { code: string }[])[0].code;
}
// We boot directly (buildApp) so the test can pass HERE, live, without a
// separately-running server — but only when LIVE=1 the whole fixture path runs.
let app: FastifyInstance | undefined;
async function boot(): Promise<void> {
  if (process.env.LIVE !== "1") return;
  const { buildApp } = await import("../src/index");
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  BASE = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
}

describe("live API against real Postgres", () => {
  beforeAll(async () => {
    await boot();
    if (skip) return;
    // Load the deterministic fixture; emits raw SQL via the app's own pool.
    const { getPool } = await import("../src/db/pool");
    await getPool().query(loadFixture());
  });

  test("health returns ok", async () => {
    if (skip) return;
    const res = await jfetch("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", db: "ok" });
  });

  test("full OTP → register → me loop (dev console codes work, no SMS needed)", async () => {
    if (skip) return;
    const phone = `+1555${String(Math.floor(10000000 + Math.random() * 89999999)).padStart(8, "0")}`;
    // 1. request a code
    const req = await jfetch("/api/v1/auth/otp/request", { method: "POST", body: JSON.stringify({ phone }) });
    expect(req.status).toBe(201);
    const devCode = req.body.dev_code as string | undefined;
    if (devCode === undefined) throw new Error("expected dev_code when OTP_PROVIDER=console");
    // 2. verify — new user → signup token
    const ver = await jfetch("/api/v1/auth/otp/verify", { method: "POST", body: JSON.stringify({ phone, code: devCode }) });
    expect(ver.status).toBe(200);
    expect(ver.body.type).toBe("signup");
    const signupToken = ver.body.signup_token as string;
    // 3. register (18+; invite code required — mint one first)
    const dob = "2001-06-15";
    const uname = `u${Math.floor(Math.random() * 1e9).toString(36)}`;
    const mint = await jfetch("/api/v1/admin/invites/mint", { method: "POST", body: JSON.stringify({ count: 1, label: "test" }) });
    expect(mint.status).toBe(201);
    const reg = await jfetch("/api/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({ signup_token: signupToken, display_name: "Test User", username: uname, dob, invite_code: (mint.body.codes as { code: string }[])[0].code }),
    });
    expect(reg.status).toBe(201);
    const sessionToken = reg.body.token as string;
    expect((reg.body.user as Record<string, unknown>).reputation_points).toBe(500);
    // 4. /me
    const me = await jfetch("/api/v1/me", { headers: { authorization: `Bearer ${sessionToken}` } });
    expect(me.status).toBe(200);
    expect((me.body.user as Record<string, unknown>).username).toBe(uname);
  });

  test("under-18 DOB is rejected with 403 and no account", async () => {
    if (skip) return;
    const phone = `+1555${String(Math.floor(10000000 + Math.random() * 89999999)).padStart(8, "0")}`;
    const req = await jfetch("/api/v1/auth/otp/request", { method: "POST", body: JSON.stringify({ phone }) });
    const ver = await jfetch("/api/v1/auth/otp/verify", { method: "POST", body: JSON.stringify({ phone, code: req.body.dev_code as string }) });
    const reg = await jfetch("/api/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({ signup_token: ver.body.signup_token, display_name: "Kid", username: `kid${Math.floor(Math.random() * 1e9).toString(36)}`, dob: "2015-01-01", invite_code: "whatever" }),
    });
    expect(reg.status).toBe(403);
  });

  test("custom spot masking: announcer sees pin, stranger sees masked address", async () => {
    if (skip) return;
    // announcer session
    const phoneA = `+1555${String(Math.floor(10000000 + Math.random() * 89999999)).padStart(8, "0")}`;
    const reqA = await jfetch("/api/v1/auth/otp/request", { method: "POST", body: JSON.stringify({ phone: phoneA }) });
    const verA = await jfetch("/api/v1/auth/otp/verify", { method: "POST", body: JSON.stringify({ phone: phoneA, code: reqA.body.dev_code }) });
    const regA = await jfetch("/api/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({ signup_token: verA.body.signup_token, display_name: "Announcer", username: `annc${Math.floor(Math.random() * 1e9).toString(36)}`, dob: "2000-01-01", invite_code: (await mintOne()) as string }),
    });
    const tokenA = regA.body.token as string;
    const spot = await jfetch("/api/v1/spots", {
      method: "POST",
      headers: { authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ name: "Party at 1234 E Orange", address: "1234 E Orange St", lat: 33.42, lon: -111.92, category: "house" }),
    });
    expect(spot.status).toBe(201);
    const spotBody = spot.body.spot as Record<string, unknown>;
    expect(spotBody.address).toBe("1234 E Orange St");
    expect(spotBody.lat).toBe(33.42);
    // stranger (no auth)
    const list = await jfetch(`/api/v1/spots?q=Party%20at`);
    const found = list.body as unknown as Record<string, unknown>[]; // search returns a bare array
    const row = found.find((s) => s.name === "Party at 1234 E Orange");
    expect(row).toBeDefined();
    if (!row) throw new Error("custom spot not found in search results");
    expect(row.masked_address).toBe("Private spot in Tempe");
    expect(row.address).toBeNull();
    expect(row.lat).toBeUndefined();
  });

  test("events: create + confirm + cancel (≥2h → free cancel)", async () => {
    if (skip) return;
    const phone = `+1555${String(Math.floor(10000000 + Math.random() * 89999999)).padStart(8, "0")}`;
    const req = await jfetch("/api/v1/auth/otp/request", { method: "POST", body: JSON.stringify({ phone }) });
    const ver = await jfetch("/api/v1/auth/otp/verify", { method: "POST", body: JSON.stringify({ phone, code: req.body.dev_code }) });
    const reg = await jfetch("/api/v1/auth/register", {
      method: "POST",
      body: JSON.stringify({ signup_token: ver.body.signup_token, display_name: "Eventi", username: `evt${Math.floor(Math.random() * 1e9).toString(36)}`, dob: "1999-01-01", invite_code: (await mintOne()) as string }),
    });
    const token = reg.body.token as string;
    // find the seeded verified spot
    const list = await jfetch("/api/v1/spots?q=The%2044");
    const firstSpot = (list.body as unknown as Record<string, unknown>[])[0];
    if (!firstSpot) throw new Error("seeded verified spot not found");
    const spotId = firstSpot.id as string;
    // create event in ~3h (inside the 14-day cap, outside 48h window for trending)
    const startAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const ev = await jfetch("/api/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ spot_id: spotId, start_at: startAt, note: "smoke" }),
    });
    expect(ev.status).toBe(201);
    const event = ev.body.event as Record<string, unknown>;
    expect(event.my_going).toBe(true);
    const eventId = event.id as string;
    // duplicate announce → conflict
    const dup = await jfetch("/api/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ spot_id: spotId, start_at: startAt }),
    });
    expect(dup.status).toBe(409);
    // cancel (≥ 2h → free cancel)
    const cancel = await jfetch(`/api/v1/events/${eventId}/going`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(cancel.status).toBe(200);
    // Slice 3: cancel now writes real settlement (ledger-backed, not report-only).
    expect((cancel.body as { settlement?: string }).settlement).toBe("free_cancel");
    expect((cancel.body as { points_delta?: number }).points_delta).toBe(0);
  });
});

// Keep TypeScript honest about unused vars in skip mode.
void mkdirSync;