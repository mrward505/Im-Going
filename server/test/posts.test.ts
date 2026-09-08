/**
 * Slice 4d-1 live tests (LIVE=1, real Postgres + booted app): check-in-gated
 * post creation, spot Live feed (order/pagination/masking), moderation reports,
 * and the local storage provider contract.
 *
 * Time control: check-ins require an open window, so events are inserted with
 * start_at = now − 10 min (window open) via SQL, Going rows created via API.
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
  const { setServerAddress } = await import("../src/lib/storage");
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  setServerAddress(app.server.address() as { port: number } | null);
  BASE = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
}

let seq = 0;
async function newUser(prefix: string): Promise<{ token: string; id: string; username: string }> {
  seq += 1;
  const phone = `+1999${String(1000000 + seq).padStart(7, "0")}${String(Math.floor(Math.random() * 1e6)).padStart(6, "0").slice(0, 3)}${String(Date.now() % 1000).padStart(3, "0")}`.slice(0, 12);
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
  return { token: reg.body.token as string, id: (reg.body.user as Record<string, unknown>).id as string, username: uname };
}

async function authz(token: string): Promise<Record<string, string>> {
  return { authorization: `Bearer ${token}` };
}

/** Deterministic local-provider object key (posts/<uuid>/<16-hex>.jpg). */
function fakeKey(userId: string): string {
  const hex = Array.from({ length: 16 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
  return `posts/${userId}/${hex}.jpg`;
}

/** Insert a verified spot + open-window event directly (bypasses announce guard). */
async function seedEvent(startOffsetMin: number, opts: { verified?: boolean } = {}): Promise<{
  spotId: string; eventId: string; lat: number; lon: number;
}> {
  const { getPool } = await import("../src/db/pool");
  const pool = getPool();
  const lat = 33.42;
  const lon = -111.93;
  const verified = opts.verified ?? true;
  const s = await pool.query<{ id: string }>(
    `INSERT INTO spots (name, address, lat, lon, geofence_radius_m, category, is_verified, city)
     VALUES ($1, $2, $3, $4, 150, 'bar', $5, 'Tempe') RETURNING id`,
    [`Slice4d Spot ${Date.now() % 1e7}-${Math.floor(Math.random() * 1e5)}`, "1 Test Way", lat, lon, verified],
  );
  const e = await pool.query<{ id: string }>(
    `INSERT INTO events (spot_id, start_at, note) VALUES ($1, now() + ($2 || ' minutes')::interval, 'slice4d') RETURNING id`,
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

/** Check in (window open, inside geofence) and return the checkin_id. */
async function checkin(token: string, eventId: string, lat: number, lon: number): Promise<string> {
  const r = await jfetch(`/api/v1/events/${eventId}/checkin`, {
    method: "POST",
    headers: await authz(token),
    body: JSON.stringify({ lat, lon, method: "manual_gps" }),
  });
  if (r.status !== 201) throw new Error(`checkin failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.checkin_id as string;
}

describe("slice 4d-1 live: posts, feed, reports, storage", () => {
  beforeAll(async () => {
    await boot();
    if (skip) return;
    const { getPool } = await import("../src/db/pool");
    const path = new URL("./fixtures/live.sql", import.meta.url).pathname;
    await getPool().query(readFileSync(path, "utf8"));
  });

  test("post creation: check-in + upload-url → 201 post, serialized with media_url", async () => {
    if (skip) return;
    const u = await newUser("poster");
    const { eventId, spotId, lat, lon } = await seedEvent(-10);
    await confirm(u.token, eventId);
    await checkin(u.token, eventId, lat, lon);
    // storage contract first: request upload slot, PUT bytes, then post
    const up = await jfetch("/api/v1/media/upload-url", {
      method: "POST",
      headers: await authz(u.token),
      body: JSON.stringify({ content_type: "image/jpeg" }),
    });
    expect(up.status).toBe(201);
    const upload = up.body.upload as Record<string, unknown>;
    expect(upload.method).toBe("PUT");
    expect(typeof upload.upload_url).toBe("string");
    expect(String(upload.object_key)).toMatch(/^posts\//);
    const put = await fetch(BASE + "/api/v1/media/upload/" + String(upload.object_key).split("/").map(encodeURIComponent).join("/"), {
      method: "PUT",
      headers: { "content-type": "image/jpeg" },
      body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
    });
    expect(put.status).toBe(201);
    const create = await jfetch(`/api/v1/events/${eventId}/posts`, {
      method: "POST",
      headers: await authz(u.token),
      body: JSON.stringify({
        type: "image",
        caption: "best night",
        object_key: upload.object_key,
        width: 1080,
        height: 1920,
      }),
    });
    expect(create.status).toBe(201);
    const post = create.body.post as Record<string, unknown>;
    expect(post.type).toBe("image");
    expect(post.caption).toBe("best night");
    expect(post.object_key).toBe(upload.object_key);
    expect(post.event_id).toBe(eventId);
    expect(post.spot_id).toBe(spotId);
    expect(typeof post.media_url).toBe("string");
    // the media URL actually serves the bytes back
    const media = await fetch(post.media_url as string);
    expect(media.status).toBe(200);
    expect(new Uint8Array(await media.arrayBuffer())[0]).toBe(0xff);
  });

  test("403 without a verified check-in (spec §2f hard rule)", async () => {
    if (skip) return;
    const u = await newUser("nocheckin");
    const { eventId } = await seedEvent(-10);
    await confirm(u.token, eventId); // going, but NO check-in
    const r = await jfetch(`/api/v1/events/${eventId}/posts`, {
      method: "POST",
      headers: await authz(u.token),
      body: JSON.stringify({ type: "image", object_key: "posts/11111111-1111-4111-8111-111111111111/aaaaaaaaaaaaaaaa.jpg" }),
    });
    expect(r.status).toBe(403);
    expect((r.body.error as Record<string, unknown>).message).toBe("must check in before posting");
  });

  test("409 duplicate post from the same check-in (UNIQUE(check_in_id))", async () => {
    if (skip) return;
    const u = await newUser("dupepost");
    const { eventId, lat, lon } = await seedEvent(-10);
    await confirm(u.token, eventId);
    await checkin(u.token, eventId, lat, lon);
    const body = JSON.stringify({
      type: "video",
      caption: "clip",
      object_key: "posts/11111111-1111-4111-8111-111111111111/bbbbbbbbbbbbbbbb.mp4",
      duration_s: 8,
    });
    const first = await jfetch(`/api/v1/events/${eventId}/posts`, {
      method: "POST",
      headers: await authz(u.token),
      body,
    });
    expect(first.status).toBe(201);
    const dupe = await jfetch(`/api/v1/events/${eventId}/posts`, {
      method: "POST",
      headers: await authz(u.token),
      body,
    });
    expect(dupe.status).toBe(409);
    expect((dupe.body.error as Record<string, unknown>).message).toBe("already posted from this check-in");
  });

  test("feed: newest-first, event info + poster identity, pagination", async () => {
    if (skip) return;
    // three different users check in to three events on ONE spot, post in order
    const { getPool } = await import("../src/db/pool");
    const pool = getPool();
    const a = await newUser("feeda");
    const b = await newUser("feedb");
    const c = await newUser("feedc");
    const spot = await pool.query<{ id: string }>(
      `INSERT INTO spots (name, address, lat, lon, geofence_radius_m, category, is_verified, city)
       VALUES ($1, '1 Feed Way', 33.42, -111.93, 150, 'bar', true, 'Tempe') RETURNING id`,
      [`Feed Spot ${Date.now() % 1e7}-${seq}`],
    );
    const spotId = spot.rows[0].id;
    async function postOnSpot(user: { token: string; id: string }, caption: string): Promise<void> {
      const e = await pool.query<{ id: string }>(
        `INSERT INTO events (spot_id, start_at, note) VALUES ($1, now() - interval '10 minutes', 'feed') RETURNING id`,
        [spotId],
      );
      await confirm(user.token, e.rows[0].id);
      await checkin(user.token, e.rows[0].id, 33.42, -111.93);
      const r = await jfetch(`/api/v1/events/${e.rows[0].id}/posts`, {
        method: "POST",
        headers: await authz(user.token),
        body: JSON.stringify({ type: "image", caption, object_key: fakeKey(user.id) }),
      });
      if (r.status !== 201) throw new Error(`feed post failed: ${JSON.stringify(r.body)}`);
    }
    await postOnSpot(a, "first");
    await postOnSpot(b, "second");
    await postOnSpot(c, "third");
    // pagination: fetch 2 at a time, newest first
    const p1 = await jfetch(`/api/v1/spots/${spotId}/feed?limit=2&offset=0`);
    expect(p1.status).toBe(200);
    const rows1 = p1.body.posts as Record<string, unknown>[];
    expect(rows1.length).toBe(2);
    expect((rows1[0] as { caption?: string }).caption).toBe("third");
    expect((rows1[1] as { caption?: string }).caption).toBe("second");
    const row = rows1[0] as Record<string, unknown>;
    // event info rides on each row
    const ev = row.event as Record<string, unknown>;
    expect(typeof ev.id).toBe("string");
    expect(typeof ev.start_at).toBe("string");
    expect(ev.going_count).toBe(1);
    // poster identity rides on each row
    const poster = row.poster as Record<string, unknown>;
    expect(String(poster.display_name).startsWith("feedc")).toBe(true);
    expect(typeof poster.star_rating).toBe("number");
    // spot card present
    const feedSpot = p1.body.spot as Record<string, unknown>;
    expect(feedSpot.id).toBe(spotId);
    expect(feedSpot.address).toBe("1 Feed Way");
    const p2 = await jfetch(`/api/v1/spots/${spotId}/feed?limit=2&offset=2`);
    const rows2 = p2.body.posts as Record<string, unknown>[];
    expect(rows2.length).toBe(1);
    expect((rows2[0] as { caption?: string }).caption).toBe("first");
    // default limit 20, cap 50
    const capped = await jfetch(`/api/v1/spots/${spotId}/feed?limit=999`);
    expect(capped.status).toBe(200);
    expect(((capped.body as { pagination: { limit: number } }).pagination).limit).toBeLessThanOrEqual(50);
  });

  test("feed: custom spot masks address for non-confirmers, unlocks for confirmed", async () => {
    if (skip) return;
    const { getPool } = await import("../src/db/pool");
    const pool = getPool();
    const creator = await newUser("cspotmk");
    const goer = await newUser("cspotgo");
    const stranger = await newUser("cspotst");
    const cs = await pool.query<{ id: string }>(
      `INSERT INTO spots (name, address, lat, lon, geofence_radius_m, category, is_verified, city, created_by)
       VALUES ($1, '999 Secret Ln', 33.42, -111.93, 100, 'house', false, 'Tempe', $2) RETURNING id`,
      [`Custom Feed Spot ${Date.now() % 1e7}-${seq}`, creator.id],
    );
    const spotId = cs.rows[0].id;
    const e = await pool.query<{ id: string }>(
      `INSERT INTO events (spot_id, start_at, note) VALUES ($1, now() - interval '10 minutes', 'custom') RETURNING id`,
      [spotId],
    );
    // goer confirms + checks in + posts
    await confirm(goer.token, e.rows[0].id);
    await checkin(goer.token, e.rows[0].id, 33.42, -111.93);
    const post = await jfetch(`/api/v1/events/${e.rows[0].id}/posts`, {
      method: "POST",
      headers: await authz(goer.token),
      body: JSON.stringify({ type: "image", caption: "lit", object_key: fakeKey(goer.id) }),
    });
    expect(post.status).toBe(201);
    // stranger sees masked card + no pin
    const anon = await jfetch(`/api/v1/spots/${spotId}/feed`, { headers: await authz(stranger.token) });
    expect(anon.status).toBe(200);
    const anonSpot = anon.body.spot as Record<string, unknown>;
    expect(anonSpot.address).toBeNull();
    expect(anonSpot.masked_address).toBe("Private spot in Tempe");
    expect("lat" in (anonSpot as object)).toBe(false);
    expect(anonSpot.lat).toBeUndefined();
    // anonymous viewer too
    const unauth = await jfetch(`/api/v1/spots/${spotId}/feed`);
    expect(((unauth.body.spot) as Record<string, unknown>).address).toBeNull();
    // confirmed goer sees the pin + address
    const confirmed = await jfetch(`/api/v1/spots/${spotId}/feed`, { headers: await authz(goer.token) });
    expect(((confirmed.body.spot) as Record<string, unknown>).address).toBe("999 Secret Ln");
    expect(((confirmed.body.spot) as Record<string, unknown>).lat).toBe(33.42);
    // creator sees it too
    const own = await jfetch(`/api/v1/spots/${spotId}/feed`, { headers: await authz(creator.token) });
    expect(((own.body.spot) as Record<string, unknown>).address).toBe("999 Secret Ln");
  });

  test("reports: create → 201; duplicate → 409; bad reason → 400; unknown post → 404", async () => {
    if (skip) return;
    const u = await newUser("reporter");
    const other = await newUser("reporter2");
    const { eventId, lat, lon } = await seedEvent(-10);
    await confirm(u.token, eventId);
    const cid = await checkin(u.token, eventId, lat, lon);
    const p = await jfetch(`/api/v1/events/${eventId}/posts`, {
      method: "POST",
      headers: await authz(u.token),
      body: JSON.stringify({ type: "image", object_key: fakeKey(u.id) }),
    });
    expect(p.status).toBe(201);
    const postId = (p.body.post as Record<string, unknown>).id as string;
    const rep = await jfetch(`/api/v1/posts/${postId}/report`, {
      method: "POST",
      headers: await authz(other.token),
      body: JSON.stringify({ reason: "spam" }),
    });
    expect(rep.status).toBe(201);
    const report = rep.body.report as Record<string, unknown>;
    expect(report.post_id).toBe(postId);
    expect(report.reason).toBe("spam");
    expect(report.status).toBe("open");
    // duplicate report by the same reporter → 409
    const dupe = await jfetch(`/api/v1/posts/${postId}/report`, {
      method: "POST",
      headers: await authz(other.token),
      body: JSON.stringify({ reason: "other" }),
    });
    expect(dupe.status).toBe(409);
    expect((dupe.body.error as Record<string, unknown>).message).toBe("you already reported this post");
    // a different reporter can still report
    const second = await jfetch(`/api/v1/posts/${postId}/report`, {
      method: "POST",
      headers: await authz(u.token),
      body: JSON.stringify({ reason: "nudity" }),
    });
    expect(second.status).toBe(201);
    // invalid reason → zod 400
    const bad = await jfetch(`/api/v1/posts/${postId}/report`, {
      method: "POST",
      headers: await authz(other.token),
      body: JSON.stringify({ reason: "cheese" }),
    });
    expect(bad.status).toBe(400);
    // unknown post → 404
    const nf = await jfetch("/api/v1/posts/00000000-0000-0000-0000-000000000000/report", {
      method: "POST",
      headers: await authz(u.token),
      body: JSON.stringify({ reason: "spam" }),
    });
    expect(nf.status).toBe(404);
    void cid;
  });

  test("going list: GET /api/v1/events/:id/going — public names + stars, sorted best-first", async () => {
    if (skip) return;
    const { getPool } = await import("../src/db/pool");
    const pool = getPool();
    const host = await newUser("goinghost");
    const low = await newUser("goinglow");
    const high = await newUser("goinghigh");
    const e = await pool.query<{ id: string }>(
      `INSERT INTO events (spot_id, start_at, note) VALUES ($1, now() + interval '3 hours', 'goinglist') RETURNING id`,
      [(await pool.query<{ id: string }>(
        `INSERT INTO spots (name, address, lat, lon, geofence_radius_m, category, is_verified, city)
         VALUES ($1, '1 Going Way', 33.42, -111.93, 150, 'bar', true, 'Tempe') RETURNING id`,
        [`Going List Spot ${Date.now() % 1e7}-${seq}`],
      )).rows[0].id],
    );
    const eventId = e.rows[0].id;
    await confirm(host.token, eventId); // announces (= confirms)
    await confirm(low.token, eventId);
    await confirm(high.token, eventId);
    // high has a verified check-in elsewhere → above the 3.0★ new-account cap;
    // low stays fresh-capped at 3.0★. Both list; high sorts first.
    const boostSpot = await pool.query<{ id: string }>(
      `INSERT INTO spots (name, address, lat, lon, geofence_radius_m, category, is_verified, city)
       VALUES ($1, '2 Boost Way', 33.42, -111.93, 150, 'club', true, 'Tempe') RETURNING id`,
      [`Boost Spot ${Date.now() % 1e7}-${seq}`],
    );
    const elsewhere = await pool.query<{ id: string }>(
      `INSERT INTO events (spot_id, start_at, note) VALUES ($1, now() - interval '10 minutes', 'boost') RETURNING id`,
      [boostSpot.rows[0].id],
    );
    await confirm(high.token, elsewhere.rows[0].id); // check-in requires an active Going
    const c = await jfetch(`/api/v1/events/${elsewhere.rows[0].id}/checkin`, {
      method: "POST",
      headers: await authz(high.token),
      body: JSON.stringify({ lat: 33.42, lon: -111.93, method: "manual_gps" }),
    });
    expect(c.status).toBe(201); // +100 pts → 3.4★ (cap lifted, still above low's 3.0★)
    const list = await jfetch(`/api/v1/events/${eventId}/going`, {
      headers: await authz(host.token),
    });
    expect(list.status).toBe(200);
    const going = list.body.going as Record<string, unknown>[];
    expect((list.body as { count: number }).count).toBe(3);
    expect(going.length).toBe(3);
    // best-first: the 3.4★ confirmer leads
    expect(String((going[0] as { username: string }).username)).toBe(high.username);
    const me = going.find((g) => (g as { is_me: boolean }).is_me === true);
    expect(me).toBeDefined();
    expect(String((me as { username: string }).username)).toBe(host.username);
    expect(typeof (going[0] as { star_rating: number }).star_rating).toBe("number");
    // unknown event → 404; malformed id → 404
    const nf = await jfetch("/api/v1/events/00000000-0000-0000-0000-000000000000/going");
    expect(nf.status).toBe(404);
    const bad = await jfetch("/api/v1/events/not-a-uuid/going");
    expect(bad.status).toBe(404);
  });

  test("storage: upload-url requires auth; serve returns 404 for foreign keys", async () => {
    if (skip) return;
    const noAuth = await jfetch("/api/v1/media/upload-url", {
      method: "POST",
      body: JSON.stringify({ content_type: "image/jpeg" }),
    });
    expect(noAuth.status).toBe(401);
    const foreign = await fetch(`${BASE}/api/v1/media/posts/00000000-0000-0000-0000-000000000000/deadbeefdeadbeef.jpg`);
    expect(foreign.status).toBe(404);
    // content-type must round-trip
    const u = await newUser("mediact");
    const up = await jfetch("/api/v1/media/upload-url", {
      method: "POST",
      headers: await authz(u.token),
      body: JSON.stringify({ content_type: "video/mp4" }),
    });
    const key = (up.body.upload as Record<string, unknown>).object_key as string;
    await fetch(`${BASE}/api/v1/media/upload/${key.split("/").map(encodeURIComponent).join("/")}`, {
      method: "PUT",
      headers: { "content-type": "video/mp4" },
      body: new Uint8Array([1, 2, 3]),
    });
    const served = await fetch(`${BASE}/api/v1/media/${key.split("/").map(encodeURIComponent).join("/")}`);
    expect(served.headers.get("content-type")).toBe("video/mp4");
  });
});
