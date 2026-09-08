import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool";
import { findUserByPhone, findUserById, serializeUser } from "../db";
import { issueOtpCode, verifyOtpCode, otpExpiry, isOtpExpired } from "../lib/otp";
import { smsProviderFromConfig } from "../lib/sms";
import { mintSessionToken, mintSignupToken, verifyToken } from "../lib/tokens";
import { ApiError, badRequest, unauthorized, forbidden, conflict } from "../lib/errors";
import { normalizeInviteCode } from "../lib/invites";
import { getConfig } from "../env";
import type { SafeUserClaims } from "../lib/tokens";
// Validate body/params with zod in handlers; Fastify schema options must NOT
// receive zod objects (see src/lib/validate.ts for the boot-time story).

const phoneSchema = z
  .string()
  .regex(/^\+[1-9][0-9]{6,14}$/, "phone must be E.164, e.g. +16025550123");

const otpRequestSchema = z.object({
  phone: phoneSchema,
});

const otpVerifySchema = z.object({
  phone: phoneSchema,
  code: z.string().regex(/^\d{6}$/),
});

const registerSchema = z.object({
  signup_token: z.string().min(1),
  display_name: z.string().min(1).max(60),
  username: z.string().regex(/^[a-z0-9_]{3,20}$/),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dob must be YYYY-MM-DD").refine((s) => !Number.isNaN(Date.parse(s)), "invalid date"),
  // Tempe launch gate (owner decision 2026-09-06): new users join only via an
  // invite code. Case-insensitive on the wire; normalized server-side.
  invite_code: z.string().trim().min(4).max(16),
});

const MAX_AGE_YEARS = 100;

/** 18+ gate (owner decision): returns years of age; throws if under 18 or implausible. */
export function assertAdult(dobIso: string): number {
  const dob = new Date(dobIso + "T00:00:00Z");
  if (Number.isNaN(dob.getTime())) throw badRequest("invalid date of birth");
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  if (age < 18) throw forbidden("I'm Going is 18+ — no account was created");
  if (age > MAX_AGE_YEARS) throw badRequest("date of birth is implausible");
  return age;
}

interface OtpBody {
  error?: { code: string; message: string };
  dev_code?: string;
  request_id: string;
  expires_at: string;
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const pool = getPool();
  const sms = smsProviderFromConfig();

  // --- request a 6-digit SMS OTP -----------------------------------------
  app.post("/api/v1/auth/otp/request", async (req, reply) => {
    const { phone } = otpRequestSchema.parse(req.body);
    const { code, codeHash } = issueOtpCode();
    const expiresAt = otpExpiry();
    const provider = sms.name;

    await sms.sendOtp(phone, code);

    const result = await pool.query<OtpBody>(
      `INSERT INTO phone_otp_requests (phone, code_hash, provider, attempts, expires_at)
       VALUES ($1, $2, $3, 0, $4)
       RETURNING id::text AS request_id, expires_at::text`,
      [phone, codeHash, provider, expiresAt],
    );
    const { request_id, expires_at } = result.rows[0];
    void expires_at;

    const body: Record<string, unknown> = {
      request_id,
      expires_at: expiresAt.toISOString(),
      provider,
      // Dev ergonomics: when OTP_PROVIDER=console the code is also returned
      // directly so curl smoke tests work without reading server logs.
      ...(provider === "console" ? { dev_code: code } : {}),
    };
    return reply.code(201).send(body);
  });

  // --- verify a code → session token (login) or signup token (new user) ---
  app.post("/api/v1/auth/otp/verify", async (req, reply) => {
    const { phone, code } = otpVerifySchema.parse(req.body);
    // Most recent, unconsumed, unexpired request for this phone.
    const { rows } = await pool.query<{
      id: string;
      code_hash: string;
      attempts: number;
      expires_at: string;
      consumed_at: string | null;
    }>(
      `SELECT id, code_hash, attempts, expires_at, consumed_at
       FROM phone_otp_requests
       WHERE phone = $1 AND consumed_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [phone],
    );
    const reqRow = rows[0];
    if (!reqRow) throw badRequest("no active code for this phone — request a new one");

    if (reqRow.attempts >= getConfig().OTP_MAX_ATTEMPTS) {
      throw badRequest("too many attempts — request a new code");
    }
    if (!verifyOtpCode(code, reqRow.code_hash)) {
      await pool.query("UPDATE phone_otp_requests SET attempts = attempts + 1 WHERE id = $1", [reqRow.id]);
      throw badRequest("invalid code");
    }
    void isOtpExpired;
    void reqRow.consumed_at;

    await pool.query("UPDATE phone_otp_requests SET consumed_at = now(), attempts = attempts + 1 WHERE id = $1", [reqRow.id]);

    const existing = await findUserByPhone(pool, phone);
    if (existing) {
      return reply.send({
        type: "login",
        token: await mintSessionToken({ sub: existing.id, phone: existing.phone }),
        user: serializeUser(existing),
      });
    }
    return reply.send({
      type: "signup",
      signup_token: await mintSignupToken({ phone, otp_request_id: reqRow.id }),
    });
  });

  // --- complete signup (18+ gate, name + username + DOB, invite code) ----
  app.post("/api/v1/auth/register", async (req, reply) => {
    const { signup_token, display_name, username, dob, invite_code } = registerSchema.parse(req.body);
    const claims = await verifyToken<SafeUserClaims>(signup_token);
    if (claims.typ !== "signup" || !claims.phone || !claims.otp_request_id) {
      throw unauthorized("invalid signup token");
    }
    assertAdult(dob); // throws forbidden for under-18 (18+ MVP)

    // The phone must have an actual verified OTP in the last request.
    const otpRow = await pool.query(
      "SELECT 1 FROM phone_otp_requests WHERE id = $1 AND phone = $2 AND consumed_at IS NOT NULL",
      [claims.otp_request_id, claims.phone],
    );
    if ((otpRow.rowCount ?? 0) === 0) throw unauthorized("signup token does not match a verified phone");

    const city = getConfig().LAUNCH_CITY;
    const code = normalizeInviteCode(invite_code);

    // Atomic redeem: user insert + code spend + redemption row in one
    // transaction. The consume is conditional (used_count < max_uses), so a
    // concurrent double-redeem of the last use fails cleanly with 409.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const codeRow = await client.query<{ id: string; max_uses: number; used_count: number }>(
        "SELECT id, max_uses, used_count FROM invite_codes WHERE code = $1 FOR UPDATE",
        [code],
      );
      const invite = codeRow.rows[0];
      if (!invite) {
        await client.query("ROLLBACK");
        throw badRequest("that invite code doesn't look right — check it and try again");
      }
      if (invite.used_count >= invite.max_uses) {
        await client.query("ROLLBACK");
        throw conflict("that invite code has already been used");
      }
      const userRes = await client.query<{ id: string }>(
        `INSERT INTO users (phone, dob, display_name, username, city, reputation_points, star_rating, invite_code_id)
         VALUES ($1, $2, $3, $4, $5, 500, 3.0, $6)
         RETURNING id`,
        [claims.phone, dob, display_name, username, city, invite.id],
      );
      const userId = userRes.rows[0].id;
      const spend = await client.query(
        "UPDATE invite_codes SET used_count = used_count + 1 WHERE id = $1 AND used_count < max_uses",
        [invite.id],
      );
      if ((spend.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        throw conflict("that invite code has already been used");
      }
      await client.query("INSERT INTO invite_redemptions (code_id, user_id) VALUES ($1, $2)", [invite.id, userId]);
      await client.query("COMMIT");
      const user = await findUserById(pool, userId);
      if (!user) throw new Error("user vanished after insert");
      return reply.code(201).send({
        token: await mintSessionToken({ sub: user.id, phone: user.phone }),
        user: serializeUser(user),
      });
    } catch (err) {
      // A duplicate phone/username racing through still surfaces as 409 via
      // the shared pg-error mapping; make sure we never leak an open txn.
      try {
        await client.query("ROLLBACK");
      } catch {
        // already rolled back / committed — the real error below is what matters
      }
      throw err;
    } finally {
      client.release();
    }
  });

  // --- who am I -----------------------------------------------------------
  app.get("/api/v1/me", async (req, reply) => {
    const claims = req.userClaims;
    const user = claims ? await findUserById(pool, claims.sub) : undefined;
    if (!user) throw unauthorized("authentication required");
    return reply.send({ user: serializeUser(user) });
  });
}