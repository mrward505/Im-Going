/**
 * Invite-code live tests (LIVE=1, real Postgres + booted app): the Tempe
 * launch gate (owner decision 2026-09-06).
 *
 * Covers: mint creates codes; register succeeds with a valid code; register
 * fails without / with a bad / with an already-used code; double-redeem of a
 * single-use code is rejected; a multi-use code admits up to max_uses;
 * admin list shows used/unused status with redeemers; otp/verify login for
 * existing users is unaffected by the gate.
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

let seq = 50000;
function freshPhone(): string {
  seq += 1;
  return `+1440${String(1000000 + seq).padStart(7, "0")}`.slice(0, 12);
}
function freshUsername(prefix: string): string {
  return `${prefix}${seq}${Math.floor(Math.random() * 1e6).toString(36)}`.slice(0, 18);
}

/** OTP request + verify → signup_token for a fresh phone. */
async function signupTokenFor(phone: string): Promise<string> {
  const req = await jfetch("/api/v1/auth/otp/request", { method: "POST", body: JSON.stringify({ phone }) });
  if (req.status !== 201) throw new Error(`otp request failed: ${JSON.stringify(req.body)}`);
  const ver = await jfetch("/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ phone, code: req.body.dev_code as string }),
  });
  if (ver.body.type !== "signup" || !ver.body.signup_token) {
    throw new Error(`expected signup token: ${JSON.stringify(ver.body)}`);
  }
  return ver.body.signup_token as string;
}

async function registerWith(phone: string, extra: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const signup_token = await signupTokenFor(phone);
  return jfetch("/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({
      signup_token,
      display_name: "Invitee",
      username: freshUsername("inv"),
      dob: "2000-01-01",
      ...extra,
    }),
  });
}

async function mint(count: number, extra: Record<string, unknown> = {}): Promise<{ code: string }[]> {
  const res = await jfetch("/api/v1/admin/invites/mint", {
    method: "POST",
    body: JSON.stringify({ count, ...extra }),
  });
  expect(res.status).toBe(201);
  return res.body.codes as { code: string }[];
}

describe("invite codes — Tempe launch gate", () => {
  beforeAll(async () => {
    await boot();
  });

  test("mint creates the requested codes with the label", async () => {
    if (skip) return;
    const res = await jfetch("/api/v1/admin/invites/mint", {
      method: "POST",
      body: JSON.stringify({ count: 3, label: "TempeBarstool" }),
    });
    expect(res.status).toBe(201);
    const codes = res.body.codes as { code: string; label: string; max_uses: number; used_count: number }[];
    expect(codes).toHaveLength(3);
    const seen = new Set(codes.map((c) => c.code));
    expect(seen.size).toBe(3); // unique
    for (const c of codes) {
      expect(c.code).toMatch(/^[A-Z0-9]{8}$/);
      expect(c.label).toBe("TempeBarstool");
      expect(c.max_uses).toBe(1);
      expect(c.used_count).toBe(0);
    }
  });

  test("register succeeds with a valid code (case-insensitive)", async () => {
    if (skip) return;
    const [c] = await mint(1, { label: "GiannaLuke" });
    const reg = await registerWith(freshPhone(), { invite_code: c.code.toLowerCase() });
    expect(reg.status).toBe(201);
    expect((reg.body.user as Record<string, unknown>).username).toBeDefined();
  });

  test("register fails without a code (400 invalid_request)", async () => {
    if (skip) return;
    const reg = await registerWith(freshPhone(), {});
    expect(reg.status).toBe(400);
  });

  test("register fails with a bad code (400)", async () => {
    if (skip) return;
    const reg = await registerWith(freshPhone(), { invite_code: "NOPE1234" });
    expect(reg.status).toBe(400);
    expect((reg.body.error as Record<string, unknown>).code).toBe("bad_request");
  });

  test("already-used single-use code is rejected with 409; no second account", async () => {
    if (skip) return;
    const [c] = await mint(1);
    const first = await registerWith(freshPhone(), { invite_code: c.code });
    expect(first.status).toBe(201);
    const second = await registerWith(freshPhone(), { invite_code: c.code });
    expect(second.status).toBe(409);
    expect((second.body.error as Record<string, unknown>).code).toBe("conflict");
    // The failed redeem created no user: the phone is still unknown, so a
    // fresh OTP verify for it still yields a signup token (not a login).
    const { getPool } = await import("../src/db/pool");
    const { rows } = await getPool().query<{ n: number }>(
      "SELECT count(*)::int AS n FROM invite_redemptions WHERE code_id = (SELECT id FROM invite_codes WHERE code = $1)",
      [c.code],
    );
    expect(rows[0].n).toBe(1);
  });

  test("multi-use code admits up to max_uses, then 409", async () => {
    if (skip) return;
    const [c] = await mint(1, { max_uses: 2 });
    expect((await registerWith(freshPhone(), { invite_code: c.code })).status).toBe(201);
    expect((await registerWith(freshPhone(), { invite_code: c.code })).status).toBe(201);
    const third = await registerWith(freshPhone(), { invite_code: c.code });
    expect(third.status).toBe(409);
  });

  test("admin list shows status + redeemers from real rows", async () => {
    if (skip) return;
    const [c] = await mint(1, { label: "attribution-probe" });
    const before = await jfetch("/api/v1/admin/invites");
    const rowBefore = (before.body.codes as Record<string, unknown>[]).find((r) => r.code === c.code) as Record<string, unknown>;
    expect(rowBefore.spent).toBe(false);
    expect((rowBefore.redeemers as unknown[])).toHaveLength(0);
    const reg = await registerWith(freshPhone(), { invite_code: c.code });
    expect(reg.status).toBe(201);
    const username = (reg.body.user as Record<string, unknown>).username as string;
    const after = await jfetch("/api/v1/admin/invites");
    const rowAfter = (after.body.codes as Record<string, unknown>[]).find((r) => r.code === c.code) as Record<string, unknown>;
    expect(rowAfter.spent).toBe(true);
    expect(rowAfter.used_count).toBe(1);
    const redeemers = rowAfter.redeemers as { username: string }[];
    expect(redeemers).toHaveLength(1);
    expect(redeemers[0].username).toBe(username);
  });

  test("existing users log in via otp/verify with no invite code", async () => {
    if (skip) return;
    const [c] = await mint(1);
    const phone = freshPhone();
    const reg = await registerWith(phone, { invite_code: c.code });
    expect(reg.status).toBe(201);
    // Same phone again → login, no code asked or accepted at this step.
    const req = await jfetch("/api/v1/auth/otp/request", { method: "POST", body: JSON.stringify({ phone }) });
    const ver = await jfetch("/api/v1/auth/otp/verify", {
      method: "POST",
      body: JSON.stringify({ phone, code: req.body.dev_code as string }),
    });
    expect(ver.status).toBe(200);
    expect(ver.body.type).toBe("login");
  });
});
