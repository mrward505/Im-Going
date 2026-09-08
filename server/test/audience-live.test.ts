/**
 * Slice 4d-3a live tests (LIVE=1, real Postgres + booted app): the
 * live-audience layer — heat badges, going_now, going_with_you, and the
 * influencer pull. Every number asserted here comes from real Going/Event
 * rows the test itself creates.
 *
 * Setup shape per test:
 *   - an "influencer" user announces an event via SQL (direct insert, so we
 *     control start_at: open window = now − 10 min for tonight-live reads);
 *   - N goer users confirm via API (real confirmations → real heat_count);
 *   - settlement runs / check-ins produce real showup + no_show verdicts.
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

let seq = 1000;
async function newUser(prefix: string): Promise<{ token: string; id: string }> {
  seq += 1;
  const phone = `+1888${String(1000000 + seq).padStart(7, "0")}${String(Math.floor(Math.random() * 1e6)).padStart(6, "0").slice(0, 3)}${String(Date.now() % 1000).padStart(3, "0")}`.slice(0, 12);
  const req = await jfetch("/api/v1/auth/otp/request", { method: "POST", body: JSON.stringify({ phone }) });
  if (req.status !== 201) throw new Error(`otp request failed: ${JSON.stringify(req.body)}`);
  const ver = await jfetch("/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ phone, code: req.body.dev_code as string }),
  });
  const uname = `${prefix}${seq}${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 18);
  const mint = await jfetch("/api/v1/admin/invites/mint", { method: "POST", body: JSON.stringify({ count: 1, label: "test" }) });
  if (mint.status !== 201) throw new Error(`invite mint failed: ${JSON.stringify(mint.body)}`);
  const inviteCode = (mint.body.codes as { code: string }[])[0].code;
  const reg = await jfetch("/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({
      signup_token: ver.body.signup_token,
      display_name: `${prefix} ${seq}`,
      username: uname,
      dob: "2000-01-01",
      invite_code: inviteCode,
    }),
  });
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  return { token: reg.body.token as string, id: (reg.body.user as Record<string, unknown>).id as string };
}

async function authz(token: string): Promise<Record<string, string>> {
  return { authorization: `Bearer ${token}` };
}

/** Verified spot + event as the influencer's announcement (SQL, controls start_at). */
async function seedAnnouncement(
  creatorId: string,
  startOffsetMin: number,
): Promise<{ spotId: string; eventId: string; lat: number; lon: number }> {
  const { getPool } = await import("../src/db/pool");
  const pool = getPool();
  const lat = 33.42;
  const lon = -111.93;
  const s = await pool.query<{ id: string }>(
    `INSERT INTO spots (name, address, lat, lon, geofence_radius_m, category, is_verified, city)
     VALUES ($1, $2, $3, $4, 150, 'bar', true, 'Tempe') RETURNING id`,
    [`Audience Spot ${Date.now() % 1e7}-${Math.floor(Math.random() * 1e5)}`, "9 Live Way", lat, lon],
  );
  const e = await pool.query<{ id: string }>(
    `INSERT INTO events (spot_id, start_at, note, created_by) VALUES ($1, now() + ($2 || ' minutes')::interval, 'live test', $3) RETURNING id`,
    [s.rows[0].id, String(startOffsetMin), creatorId],
  );
  // The announcer's own Going row (what announce does via API).
  await pool.query("INSERT INTO going (event_id, user_id, status) VALUES ($1, $2, 'active')", [
    e.rows[0].id,
    creatorId,
  ]);
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

describe("slice 4d-3a live: heat, going-with-you, influencer pull", () => {
  beforeAll(async () => {
    await boot();
    if (skip) return;
    const { getPool } = await import("../src/db/pool");
    const path = new URL("./fixtures/live.sql", import.meta.url).pathname;
    await getPool().query(readFileSync(path, "utf8"));
  });

  test("spot detail carries live signals: going_now + heat from real confirmations", async () => {
    if (skip) return;
    const star = await newUser("star");
    // Event started 10 min ago → window open → "tonight-live".
    const { spotId, eventId } = await seedAnnouncement(star.id, -10);
    // 4 real confirmations in the last hour (creator row is older than the
    // confirms but same hour — heat counts ALL real active goings).
    for (let i = 0; i < 4; i += 1) {
      const g = await newUser("fan");
      await confirm(g.token, eventId);
    }
    const detail = await jfetch(`/api/v1/spots/${spotId}`, { headers: await authz(star.token) });
    expect(detail.status).toBe(200);
    // 1 creator + 4 fans active; window open → all 5 are going_now.
    expect(detail.body.going_now).toBe(5);
    // 5 confirmations in the last hour → warming (3–5).
    expect(detail.body.heat_count).toBe(5);
    expect(detail.body.heat_level).toBe(1);
    // Backward compat: the old fields are untouched.
    expect(detail.body.going_count).toBe(5);
    expect(detail.body.my_going).toBe(true);
    // going_with_you excludes ME: 4 other people.
    expect(detail.body.going_with_you).toBe(4);
  });

  test("cold spot stays calm: no window, no confirmations → zeros", async () => {
    if (skip) return;
    const star = await newUser("coldstar");
    // Event 3 days out: outside the live window, no goers but the creator.
    const { spotId } = await seedAnnouncement(star.id, 3 * 24 * 60);
    const detail = await jfetch(`/api/v1/spots/${spotId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.going_now).toBe(0);
    // Only the creator's row, created just now (< 60 min) → heat_count 1 → calm.
    expect(detail.body.heat_count).toBe(1);
    expect(detail.body.heat_level).toBe(0);
    // Anonymous: no self to exclude → null.
    expect(detail.body.going_with_you).toBeNull();
  });

  test("my announcements carry going_with_you (excludes self), incl. recent", async () => {
    if (skip) return;
    const star = await newUser("withyou");
    const { eventId } = await seedAnnouncement(star.id, 180); // tonight, future
    const a = await newUser("wya");
    const b = await newUser("wyb");
    await confirm(a.token, eventId);
    await confirm(b.token, eventId);
    const mine = await jfetch("/api/v1/me/going", { headers: await authz(star.token) });
    expect(mine.status).toBe(200);
    const upcoming = mine.body.upcoming as Array<Record<string, unknown>>;
    const row = upcoming.find((r) => (r.event as Record<string, unknown>).id === eventId);
    expect(row).toBeDefined();
    // Creator + 2 fans = 3 active, minus me = 2 with me.
    expect(row!.going_with_you).toBe(2);
  });

  test("event detail going_with_you excludes the viewer", async () => {
    if (skip) return;
    const star = await newUser("evdetail");
    const { eventId } = await seedAnnouncement(star.id, 180);
    const fan = await newUser("evfan");
    await confirm(fan.token, eventId);
    const mine = await jfetch(`/api/v1/events/${eventId}`, { headers: await authz(star.token) });
    expect(mine.status).toBe(200);
    const ev = mine.body.event as Record<string, unknown>;
    expect(ev.going_count).toBe(2);
    expect(ev.going_with_you).toBe(1); // just the fan, not me
    const anon = await jfetch(`/api/v1/events/${eventId}`);
    expect((anon.body.event as Record<string, unknown>).going_with_you).toBeNull();
  });

  test("influencer pull: announcements, drawn audience, follow-through with a real no-show", async () => {
    if (skip) return;
    const { getPool } = await import("../src/db/pool");
    const pool = getPool();
    const star = await newUser("pullstar");
    // Two announced events with elapsed windows (start 200 min ago → settled).
    const first = await seedAnnouncement(star.id, -200);
    const second = await seedAnnouncement(star.id, -200);
    // Event 1: one goer checks in (showup) + one goer no-shows.
    const show = await newUser("pullshow");
    const noshow = await newUser("pullno");
    await confirm(show.token, first.eventId);
    await confirm(noshow.token, first.eventId);
    // Event 2: one more confirmation, still pending (window elapsed but no
    // settlement run on it yet — pending rows must NOT count as verdicts).
    const pending = await newUser("pullpend");
    await confirm(pending.token, second.eventId);
    // Check the show-up goer in: window is elapsed for -200 min start, so
    // settle directly via the runner path instead — mark permission flags
    // then run settlement: show-goer has a checkin row? No — window closed,
    // check-in is impossible. Create the verdicts directly the way the
    // settlement runner would: show-goer gets a checkin + showup, no-show
    // goer gets permission + no_show.
    await pool.query(
      `INSERT INTO checkins (event_id, user_id, spot_id, verified_at, method, lat, lon, accuracy_m)
       VALUES ($1, $2, $3, now() - interval '190 minutes', 'manual_gps', $4, $5, 10)`,
      [first.eventId, show.id, first.spotId, first.lat, first.lon],
    );
    await pool.query("UPDATE users SET location_permission_granted = true WHERE id = $1", [noshow.id]);
    const runner = await newUser("pullrun");
    const run = await jfetch("/api/v1/settlement/run", {
      method: "POST",
      headers: await authz(runner.token),
      body: JSON.stringify({}),
    });
    expect(run.status).toBe(200);
    const pull = await jfetch(`/api/v1/users/${star.id}/pull`);
    expect(pull.status).toBe(200);
    const p = pull.body.pull as Record<string, unknown>;
    // 2 announcements; creator's own rows excluded from the draw.
    expect(p.announcements_total).toBe(2);
    // Event1: show + noshow (2, creator excluded); Event2: pending (1).
    // NOTE: pending goer may have been settled by the runner too (runner
    // settles ALL elapsed open goings): pending user has no permission flag
    // → unverifiable (neutral, non-verdict). Drawn count still includes them.
    expect(p.confirmations_drawn_total).toBe(3);
    // Verdicts: show + no_show = 2; unverifiable + unsettled rows excluded.
    expect(p.goers_follow_through_pct).toBe(50);
    expect(p.avg_confirmations_per_announcement).toBe(1.5);
    // /me/pull agrees.
    const mePull = await jfetch("/api/v1/me/pull", { headers: await authz(star.token) });
    expect(mePull.status).toBe(200);
    expect((mePull.body.pull as Record<string, unknown>).goers_follow_through_pct).toBe(50);
  });

  test("fresh user pull: zeros and nulls, honest types", async () => {
    if (skip) return;
    const fresh = await newUser("freshpull");
    const pull = await jfetch(`/api/v1/users/${fresh.id}/pull`);
    expect(pull.status).toBe(200);
    expect(pull.body.pull).toMatchObject({
      announcements_total: 0,
      confirmations_drawn_total: 0,
      goers_follow_through_pct: null,
      avg_confirmations_per_announcement: null,
    });
  });

  test("unknown user pull → 404", async () => {
    if (skip) return;
    const r = await jfetch("/api/v1/users/00000000-0000-4000-8000-000000000000/pull");
    expect(r.status).toBe(404);
  });

  test("share card carries live signals + 10/day budget (unchanged gate)", async () => {
    if (skip) return;
    const star = await newUser("sharelive");
    const { spotId, eventId } = await seedAnnouncement(star.id, -10);
    const fan = await newUser("sharefan");
    await confirm(fan.token, eventId);
    const share = await jfetch(`/api/v1/spots/${spotId}/share`, { headers: await authz(star.token) });
    expect(share.status).toBe(200);
    const card = share.body.card as Record<string, unknown>;
    expect(card.next_start_at).toBeDefined();
    expect(card.going_count).toBe(2);
    expect(card.going_now).toBe(2); // window open, both active
    expect(card.heat_count).toBe(2);
    expect(card.heat_level).toBe(0); // 2 confirmations → calm
    const budget = share.body.share as Record<string, unknown>;
    expect(budget.limit).toBe(10);
    expect(typeof budget.remaining).toBe("number");
  });
});
