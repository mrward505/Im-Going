/**
 * REVAMP 3 live tests (LIVE=1, real Postgres + booted app): social import.
 *
 * Covers: claim-gated create, verified-check-in-backed create, the hard 3-post
 * cap, invalid spot/URL handling, the explicit-claim gate (no auto-asserted
 * check-ins), duplicate-URL guard, media contract resolution, list + delete,
 * ownership, and custom-spot masking for the owner.
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
  const { setServerAddress } = await import("../src/lib/storage");
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  setServerAddress(app.server.address() as { port: number } | null);
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

function authz(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function seedSpot(opts: { verified?: boolean } = {}): Promise<{ spotId: string; name: string }> {
  const { getPool } = await import("../src/db/pool");
  const pool = getPool();
  const verified = opts.verified ?? true;
  const category = verified ? "bar" : "house";
  const s = await pool.query<{ id: string }>(
    `INSERT INTO spots (name, address, lat, lon, geofence_radius_m, category, is_verified, city)
     VALUES ($1, $2, 33.42, -111.93, 150, $4, $3, 'Tempe') RETURNING id`,
    [`Import Spot ${Date.now() % 1e7}-${seq}`, "1 Import Way", verified, category],
  );
  return { spotId: s.rows[0].id, name: `Import Spot ${Date.now() % 1e7}-${seq}` };
}

async function seedCheckedInSpot(token: string): Promise<{ spotId: string; checkinId: string }> {
  const { getPool } = await import("../src/db/pool");
  const pool = getPool();
  const s = await pool.query<{ id: string }>(
    `INSERT INTO spots (name, address, lat, lon, geofence_radius_m, category, is_verified, city)
     VALUES ($1, '5 Checked Way', 33.42, -111.93, 150, 'club', true, 'Tempe') RETURNING id`,
    [`Checkin Spot ${Date.now() % 1e7}-${seq}`],
  );
  const spotId = s.rows[0].id;
  const e = await pool.query<{ id: string }>(
    `INSERT INTO events (spot_id, start_at, note) VALUES ($1, now() - interval '10 minutes', 'import') RETURNING id`,
    [spotId],
  );
  const go = await jfetch(`/api/v1/events/${e.rows[0].id}/going`, {
    method: "POST",
    headers: authz(token),
    body: JSON.stringify({}),
  });
  if (go.status !== 201) throw new Error(`confirm failed: ${go.status} ${JSON.stringify(go.body)}`);
  const c = await jfetch(`/api/v1/events/${e.rows[0].id}/checkin`, {
    method: "POST",
    headers: authz(token),
    body: JSON.stringify({ lat: 33.42, lon: -111.93, method: "manual_gps" }),
  });
  if (c.status !== 201) throw new Error(`checkin failed: ${c.status} ${JSON.stringify(c.body)}`);
  return { spotId, checkinId: c.body.checkin_id as string };
}

function importBody(spotId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    platform: "instagram",
    source_url: `https://www.instagram.com/p/${Math.random().toString(36).slice(2, 14)}/`,
    spot_id: spotId,
    caption: "best night of the year",
    been_there: "claim",
    ...overrides,
  };
}

describe("revamp 3 live: social import (bring your nights)", () => {
  beforeAll(async () => {
    await boot();
  });

  test("claim-backed import → 201 with pending verification + recent signal", async () => {
    if (skip) return;
    const u = await newUser("impc");
    const { spotId } = await seedSpot();
    const r = await jfetch("/api/v1/me/imports", {
      method: "POST",
      headers: authz(u.token),
      body: JSON.stringify(importBody(spotId)),
    });
    expect(r.status).toBe(201);
    const imp = r.body.imported as Record<string, unknown>;
    expect(imp.platform).toBe("instagram");
    expect(imp.source_url).toMatch(/^https:\/\/www\.instagram\.com/);
    expect(imp.caption).toBe("best night of the year");
    expect((imp.been_there as Record<string, unknown>).kind).toBe("claim");
    expect((imp.been_there as Record<string, unknown>).check_in_id).toBeNull();
    expect(imp.verification).toBe("pending");
    expect(imp.is_recent).toBe(true);
    expect((imp.spot as Record<string, unknown>).id).toBe(spotId);
    expect((imp.spot as Record<string, unknown>).address).toBe("1 Import Way");
    expect((r.body as { imports_remaining: number }).imports_remaining).toBe(2);
    // list it back
    const list = await jfetch("/api/v1/me/imports", { headers: authz(u.token) });
    expect(list.status).toBe(200);
    expect((list.body.imports as unknown[]).length).toBe(1);
    expect((list.body as { limit: number }).limit).toBe(3);
    expect((list.body as { remaining: number }).remaining).toBe(2);
  });

  test("real verified check-in backs the import (kind=checkin, verified) — never auto-asserted", async () => {
    if (skip) return;
    const u = await newUser("impv");
    const { spotId, checkinId } = await seedCheckedInSpot(u.token);
    const r = await jfetch("/api/v1/me/imports", {
      method: "POST",
      headers: authz(u.token),
      body: JSON.stringify(importBody(spotId, { been_there: "checkin" })),
    });
    expect(r.status).toBe(201);
    const imp = r.body.imported as Record<string, unknown>;
    expect((imp.been_there as Record<string, unknown>).kind).toBe("checkin");
    expect((imp.been_there as Record<string, unknown>).check_in_id).toBe(checkinId);
    expect(imp.verification).toBe("verified");
  });

  test("been_there:'checkin' WITHOUT a real check-in → 400 (no fabricated verification)", async () => {
    if (skip) return;
    const u = await newUser("impno");
    const { spotId } = await seedSpot();
    const r = await jfetch("/api/v1/me/imports", {
      method: "POST",
      headers: authz(u.token),
      body: JSON.stringify(importBody(spotId, { been_there: "checkin" })),
    });
    expect(r.status).toBe(400);
    expect(String((r.body.error as Record<string, unknown>).message)).toContain("no verified check-in");
  });

  test("omitted been_there without a check-in → 400 (must explicitly claim)", async () => {
    if (skip) return;
    const u = await newUser("impom");
    const { spotId } = await seedSpot();
    const body = importBody(spotId) as Record<string, unknown>;
    delete body.been_there;
    const r = await jfetch("/api/v1/me/imports", {
      method: "POST",
      headers: authz(u.token),
      body: JSON.stringify(body),
    });
    expect(r.status).toBe(400);
    expect(String((r.body.error as Record<string, unknown>).message)).toContain("claim");
  });

  test("omitted been_there WITH a real check-in → auto uses checkin (safe default)", async () => {
    if (skip) return;
    const u = await newUser("impauto");
    const { spotId } = await seedCheckedInSpot(u.token);
    const body = importBody(spotId) as Record<string, unknown>;
    delete body.been_there;
    const r = await jfetch("/api/v1/me/imports", {
      method: "POST",
      headers: authz(u.token),
      body: JSON.stringify(body),
    });
    expect(r.status).toBe(201);
    expect((r.body.imported as Record<string, unknown>).verification).toBe("verified");
    expect(((r.body.imported as Record<string, unknown>).been_there as Record<string, unknown>).kind).toBe("checkin");
  });

  test("hard cap: 3 imports allowed, 4th → 409 (and trigger backstops)", async () => {
    if (skip) return;
    const u = await newUser("impcap");
    const { spotId } = await seedSpot();
    for (let i = 0; i < 3; i += 1) {
      const r = await jfetch("/api/v1/me/imports", {
        method: "POST",
        headers: authz(u.token),
        body: JSON.stringify(importBody(spotId, { source_url: `https://www.instagram.com/p/cap${i}${Math.random().toString(36).slice(2, 10)}/` })),
      });
      expect(r.status).toBe(201);
      expect((r.body as { imports_remaining: number }).imports_remaining).toBe(2 - i);
    }
    const fourth = await jfetch("/api/v1/me/imports", {
      method: "POST",
      headers: authz(u.token),
      body: JSON.stringify(importBody(spotId)),
    });
    expect(fourth.status).toBe(409);
    expect(String((fourth.body.error as Record<string, unknown>).message)).toContain("import limit reached");
  });

  test("cap is per-user: another user can still import 3", async () => {
    if (skip) return;
    const u = await newUser("impother");
    const u2 = await newUser("impother2");
    const { spotId } = await seedSpot();
    for (let i = 0; i < 3; i += 1) {
      const r = await jfetch("/api/v1/me/imports", {
        method: "POST",
        headers: authz(u.token),
        body: JSON.stringify(importBody(spotId, { source_url: `https://www.instagram.com/p/oth${i}${Math.random().toString(36).slice(2, 10)}/` })),
      });
      expect(r.status).toBe(201);
    }
    const r2 = await jfetch("/api/v1/me/imports", {
      method: "POST",
      headers: authz(u2.token),
      body: JSON.stringify(importBody(spotId)),
    });
    expect(r2.status).toBe(201);
  });

  test("invalid spot → 404; malformed/unknown URL → 400", async () => {
    if (skip) return;
    const u = await newUser("impbad");
    const r = await jfetch("/api/v1/me/imports", {
      method: "POST",
      headers: authz(u.token),
      body: JSON.stringify(importBody("00000000-0000-0000-0000-000000000000")),
    });
    expect(r.status).toBe(404);
    const badUrl = await jfetch("/api/v1/me/imports", {
      method: "POST",
      headers: authz(u.token),
      body: JSON.stringify(importBody((await seedSpot()).spotId, { source_url: "not-a-url" })),
    });
    expect(badUrl.status).toBe(400);
    const badMedia = await jfetch("/api/v1/me/imports", {
      method: "POST",
      headers: authz(u.token),
      body: JSON.stringify(importBody((await seedSpot()).spotId, { media_url: "not-a-url" })),
    });
    expect(badMedia.status).toBe(400);
  });

  test("duplicate source_url for the same user → 409", async () => {
    if (skip) return;
    const u = await newUser("impdup");
    const { spotId } = await seedSpot();
    const body = importBody(spotId);
    const first = await jfetch("/api/v1/me/imports", { method: "POST", headers: authz(u.token), body: JSON.stringify(body) });
    expect(first.status).toBe(201);
    const dupe = await jfetch("/api/v1/me/imports", { method: "POST", headers: authz(u.token), body: JSON.stringify(body) });
    expect(dupe.status).toBe(409);
    expect(String((dupe.body.error as Record<string, unknown>).message)).toContain("already imported");
  });

  test("media resolution: unknown object_key → 400; minted key resolves to media_url", async () => {
    if (skip) return;
    const u = await newUser("impmed");
    const { spotId } = await seedSpot();
    const junk = await jfetch("/api/v1/me/imports", {
      method: "POST",
      headers: authz(u.token),
      body: JSON.stringify(importBody(spotId, { object_key: "posts/11111111-1111-4111-8111-111111111111/deadbeefdeadbeef.jpg" })),
    });
    expect(junk.status).toBe(400);
    // two media sources at once → 400
    const both = await jfetch("/api/v1/me/imports", {
      method: "POST",
      headers: authz(u.token),
      body: JSON.stringify(importBody(spotId, {
        media_url: "https://cdn.example.com/me.jpg",
        object_key: "posts/11111111-1111-4111-8111-111111111111/deadbeefdeadbeef.jpg",
      })),
    });
    expect(both.status).toBe(400);
    // real contract: request upload URL → PUT bytes → import with object_key
    const up = await jfetch("/api/v1/media/upload-url", {
      method: "POST",
      headers: authz(u.token),
      body: JSON.stringify({ content_type: "image/jpeg" }),
    });
    expect(up.status).toBe(201);
    const upload = up.body.upload as Record<string, unknown>;
    const put = await fetch(BASE + "/api/v1/media/upload/" + String(upload.object_key).split("/").map(encodeURIComponent).join("/"), {
      method: "PUT",
      headers: { "content-type": "image/jpeg" },
      body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
    });
    expect(put.status).toBe(201);
    const created = await jfetch("/api/v1/me/imports", {
      method: "POST",
      headers: authz(u.token),
      body: JSON.stringify(importBody(spotId, { object_key: upload.object_key })),
    });
    expect(created.status).toBe(201);
    const mediaUrl = (created.body.imported as Record<string, unknown>).media_url as string;
    expect(mediaUrl).toContain("/api/v1/media/");
    const served = await fetch(mediaUrl);
    expect(served.status).toBe(200);
  });

  test("external media_url is stored verbatim (user-hosted, honest provenance)", async () => {
    if (skip) return;
    const u = await newUser("impext");
    const { spotId } = await seedSpot();
    const r = await jfetch("/api/v1/me/imports", {
      method: "POST",
      headers: authz(u.token),
      body: JSON.stringify(importBody(spotId, { media_url: "https://cdn.example.com/night-out.jpg" })),
    });
    expect(r.status).toBe(201);
    expect((r.body.imported as Record<string, unknown>).media_url).toBe("https://cdn.example.com/night-out.jpg");
  });

  test("delete frees a slot; deleting someone else's import → 403; unknown → 404", async () => {
    if (skip) return;
    const u = await newUser("impdel");
    const other = await newUser("impdel2");
    const { spotId } = await seedSpot();
    const a = await jfetch("/api/v1/me/imports", {
      method: "POST",
      headers: authz(u.token),
      body: JSON.stringify(importBody(spotId)),
    });
    const b = await jfetch("/api/v1/me/imports", {
      method: "POST",
      headers: authz(u.token),
      body: JSON.stringify(importBody(spotId, {
        source_url: `https://www.instagram.com/p/del${Math.random().toString(36).slice(2, 10)}/`,
        platform: "x",
      })),
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const id = (a.body.imported as Record<string, unknown>).id as string;
    // someone else's import → 403
    const foreign = await jfetch(`/api/v1/me/imports/${id}`, { method: "DELETE", headers: authz(other.token) });
    expect(foreign.status).toBe(403);
    // unknown → 404
    const nf = await jfetch("/api/v1/me/imports/00000000-0000-0000-0000-000000000000", { method: "DELETE", headers: authz(u.token) });
    expect(nf.status).toBe(404);
    // delete → slot freed (remaining 2 → then 3)
    const del = await jfetch(`/api/v1/me/imports/${id}`, { method: "DELETE", headers: authz(u.token) });
    expect(del.status).toBe(200);
    expect((del.body as { imports_remaining: number }).imports_remaining).toBe(2);
    // can import again (cap freed)
    const again = await jfetch("/api/v1/me/imports", {
      method: "POST",
      headers: authz(u.token),
      body: JSON.stringify(importBody(spotId)),
    });
    expect(again.status).toBe(201);
  });

  test("custom (house) spot: owner sees pin+address on their own import; auth required for list", async () => {
    if (skip) return;
    const u = await newUser("impown");
    const { spotId } = await seedSpot({ verified: false });
    const r = await jfetch("/api/v1/me/imports", {
      method: "POST",
      headers: authz(u.token),
      body: JSON.stringify(importBody(spotId)),
    });
    expect(r.status).toBe(201);
    const spot = (r.body.imported as Record<string, unknown>).spot as Record<string, unknown>;
    expect(spot.masked_address).toBe("Private spot in Tempe");
    expect(spot.address).toBe("1 Import Way"); // owner confirmed → pin visible
    // no auth → 401 on list
    const anon = await jfetch("/api/v1/me/imports");
    expect(anon.status).toBe(401);
  });
});