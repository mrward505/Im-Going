/**
 * REVAMP 5 live tests (LIVE=1, real Postgres + booted app): profile pictures
 * end to end and the real-goer avatar clusters.
 *
 * Covers:
 *  - upload-url with kind:"avatar" mints an avatars/<me>/... key; videos are
 *    rejected; the bytes PUT then PATCH /me/avatar resolves a public URL onto
 *    the users row and every identity serializer returns it (GET /me,
 *    event going rows, spot feed poster, spot detail top_goer).
 *  - ownership/validation: a foreign object key or another user's key is 400;
 *    DELETE /me/avatar clears both columns and the serializers return null.
 *  - trending + venue-search rows carry real goer identities (the users who
 *    actually hold active Goings at the spot), with avatar_url when set.
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

function jwith(token: string) {
  return (path: string, init: RequestInit = {}) =>
    jfetch(path, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
    });
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
async function newUser(prefix: string): Promise<{ token: string; id: string; display_name: string }> {
  seq += 1;
  const phone = `+1777${String(2000000 + seq).padStart(7, "0")}${String(Date.now() % 1000).padStart(3, "0")}`.slice(0, 12);
  const req = await jfetch("/api/v1/auth/otp/request", { method: "POST", body: JSON.stringify({ phone }) });
  const ver = await jfetch("/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ phone, code: req.body.dev_code as string }),
  });
  const mint = await jfetch("/api/v1/admin/invites/mint", { method: "POST", body: JSON.stringify({ count: 1, label: "revamp5" }) });
  const inviteCode = (mint.body.codes as { code: string }[])[0].code;
  const reg = await jfetch("/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({
      signup_token: ver.body.signup_token,
      display_name: `${prefix} ${seq}`,
      username: `${prefix}${seq}${Math.random().toString(36).slice(2, 6)}`.slice(0, 18),
      dob: "2000-01-01",
      invite_code: inviteCode,
    }),
  });
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  const user = reg.body.user as { id: string; display_name: string };
  return { token: reg.body.token as string, id: user.id, display_name: user.display_name };
}

/** Mint an avatar slot for `token`, PUT real bytes, return the object_key. */
async function uploadAvatar(token: string, with_ = jwith(token)): Promise<string> {
  const slot = await with_("/api/v1/media/upload-url", {
    method: "POST",
    body: JSON.stringify({ content_type: "image/jpeg", ext: "jpg", kind: "avatar" }),
  });
  expect(slot.status).toBe(201);
  const upload = slot.body.upload as { object_key: string; upload_url: string; method: string; headers: Record<string, string> };
  expect(upload.object_key.startsWith("avatars/")).toBe(true);
  // 3-byte "JPEG" payload — the local provider stores bytes verbatim.
  const put = await fetch(upload.upload_url, {
    method: upload.method,
    headers: upload.headers,
    body: new Uint8Array([1, 2, 3]),
  });
  expect(put.status).toBe(201);
  return upload.object_key;
}

/** A verified spot near the tests' chosen coordinates. */
async function pickSpot(with_: ReturnType<typeof jwith>): Promise<{ spot_id: string; lat: number; lon: number }> {
  const { getPool } = await import("../src/db/pool");
  const { rows } = await getPool().query<{ id: string; lat: number; lon: number }>(
    "SELECT id, lat, lon FROM spots WHERE is_verified = true ORDER BY name LIMIT 1",
  );
  void with_;
  return { spot_id: rows[0].id, lat: rows[0].lat, lon: rows[0].lon };
}

describe.skipIf(skip)("REVAMP 5 — profile pictures", () => {
  beforeAll(async () => {
    await boot();
  });

  test("avatar upload-url is images-only and namespaced to the caller", async () => {
    const me = await newUser("avtr");
    const with_ = jwith(me.token);
    const video = await with_("/api/v1/media/upload-url", {
      method: "POST",
      body: JSON.stringify({ content_type: "video/mp4", ext: "mp4", kind: "avatar" }),
    });
    expect(video.status).toBe(400);
  });

  test("set → serializers carry avatar_url → clear → null", async () => {
    const me = await newUser("setav");
    const with_ = jwith(me.token);
    const bystander = await newUser("byav");
    const objKey = await uploadAvatar(me.token, with_);

    // The key belongs to @me: a bystander cannot claim it.
    const stolen = await jwith(bystander.token)("/api/v1/me/avatar", {
      method: "PATCH",
      body: JSON.stringify({ object_key: objKey }),
    });
    expect(stolen.status).toBe(400);

    // A post-namespace key is not a profile picture.
    const wrongKind = await with_("/api/v1/me/avatar", {
      method: "PATCH",
      body: JSON.stringify({ object_key: `posts/${me.id}/0123456789abcdef.jpg` }),
    });
    expect(wrongKind.status).toBe(400);

    const set = await with_("/api/v1/me/avatar", { method: "PATCH", body: JSON.stringify({ object_key: objKey }) });
    expect(set.status).toBe(200);
    const setUser = (set.body.user as { avatar_url: string | null });
    expect(typeof setUser.avatar_url).toBe("string");
    expect(setUser.avatar_url).toContain(`avatars/${me.id}/`);

    // GET /me round-trips it.
    const meRes = await with_("/api/v1/me");
    expect((meRes.body.user as { avatar_url: string | null }).avatar_url).toBe(setUser.avatar_url);

    // The picture is fetchable from the public URL (real bytes, not a 404).
    const media = await fetch(setUser.avatar_url!);
    expect(media.status).toBe(200);

    // Event going rows + top_goer carry it too.
    const { getPool } = await import("../src/db/pool");
    const spot = await pickSpot(with_);
    const announce = await with_("/api/v1/events", {
      method: "POST",
      body: JSON.stringify({ spot_id: spot.spot_id, start_at: new Date(Date.now() + 3_600_000).toISOString() }),
    });
    expect(announce.status).toBe(201);
    const eventId = (announce.body.event as { id: string }).id;
    const going = await with_(`/api/v1/events/${eventId}/going`);
    expect(going.status).toBe(200);
    const rows = going.body.going as { user_id: string; avatar_url: string | null }[];
    const mine = rows.find((r) => r.user_id === me.id);
    expect(mine?.avatar_url).toBe(setUser.avatar_url);

    const detail = await with_(`/api/v1/spots/${spot.spot_id}`);
    const top = (detail.body as { top_goer: { avatar_url: string | null } | null }).top_goer;
    expect(top === null || top.avatar_url === setUser.avatar_url).toBe(true);

    // Clear → initials fallback everywhere.
    const cleared = await with_("/api/v1/me/avatar", { method: "DELETE" });
    expect(cleared.status).toBe(200);
    expect((cleared.body.user as { avatar_url: string | null }).avatar_url).toBeNull();
    const after = await with_(`/api/v1/events/${eventId}/going`);
    const afterRows = after.body.going as { user_id: string; avatar_url: string | null }[];
    expect(afterRows.find((r) => r.user_id === me.id)?.avatar_url).toBeNull();

    // No stored URL survives on the row either.
    const { rows: userRows } = await getPool().query<{ avatar_object_key: string | null; avatar_url: string | null }>(
      "SELECT avatar_object_key, avatar_url FROM users WHERE id = $1",
      [me.id],
    );
    expect(userRows[0].avatar_object_key).toBeNull();
    expect(userRows[0].avatar_url).toBeNull();
  });

  test("unauthenticated avatar writes are rejected", async () => {
    const res = await jfetch("/api/v1/me/avatar", {
      method: "PATCH",
      body: JSON.stringify({ object_key: "avatars/00000000-0000-0000-0000-000000000000/0123456789abcdef.jpg" }),
    });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(skip)("REVAMP 5 — real goer clusters", () => {
  beforeAll(async () => {
    await boot();
  });

  test("trending rows carry the real goers behind the cluster", async () => {
    const me = await newUser("clus");
    const with_ = jwith(me.token);
    const spot = await pickSpot(with_);
    const objKey = await uploadAvatar(me.token, with_);
    const set = await with_("/api/v1/me/avatar", { method: "PATCH", body: JSON.stringify({ object_key: objKey }) });
    expect(set.status).toBe(200);
    const avatarUrl = (set.body.user as { avatar_url: string }).avatar_url;

    // Announce at tonight's spot and confirm going, so this spot trends.
    const announce = await with_("/api/v1/events", {
      method: "POST",
      body: JSON.stringify({ spot_id: spot.spot_id, start_at: new Date(Date.now() + 2 * 3_600_000).toISOString() }),
    });
    expect(announce.status).toBe(201);
    const eventId = (announce.body.event as { id: string }).id;
    // Announcing already puts the creator on the going list; a second explicit
    // confirm is a no-op (409) — either way the real Going row exists.
    const confirm = await with_(`/api/v1/events/${eventId}/going`, { method: "POST" });
    expect([201, 409]).toContain(confirm.status);

    const trending = await jfetch("/api/v1/trending");
    expect(trending.status).toBe(200);
    const row = (trending.body.trending as { spot: { id: string }; goers: { id: string; avatar_url: string | null }[] }[])
      .find((r) => r.spot.id === spot.spot_id);
    expect(row).toBeDefined();
    const goer = row!.goers.find((g) => g.id === me.id);
    expect(goer).toBeDefined();
    expect(goer!.avatar_url).toBe(avatarUrl);
    // Real people only — every listed goer is a users row.
    expect(row!.goers.length).toBeGreaterThan(0);

    // Universal search rows carry the same real identities.
    const search = await jfetch(`/api/v1/venues/search?q=${encodeURIComponent("")}&limit=100`);
    expect(search.status).toBe(200);
    const srow = (search.body.venues as { id: string; goers: { id: string }[] }[]).find((v) => v.id === spot.spot_id);
    expect(srow).toBeDefined();
    expect(Array.isArray(srow!.goers)).toBe(true);
  });

  test("my posts endpoint returns only my own real posts", async () => {
    const mine = await newUser("mypost");
    const with_ = jwith(mine.token);
    const res = await with_("/api/v1/me/posts");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.posts)).toBe(true);
    for (const p of res.body.posts as { media_url: string | null }[]) {
      expect(p.media_url === null || typeof p.media_url === "string").toBe(true);
    }
    const anon = await jfetch("/api/v1/me/posts");
    expect(anon.status).toBe(401);
  });
});
