/**
 * Token minting/verification using Web Crypto (HS256), no external auth dep.
 * Two token types share one JWT JSON payload shape with a `typ` claim:
 *  - "session": authenticated API access (Bearer token)
 *  - "signup": one-shot handoff from OTP verify → register (unauthenticated)
 */
import { getConfig } from "../env";

export type TokenType = "session" | "signup";

export interface SafeUserClaims {
  typ: TokenType;
  sub: string; // user id for session tokens
  phone: string;
  /** Nonce bound to the consuming OTP request row (signup tokens only). */
  otp_request_id?: string;
  iat: number;
  exp: number;
}

const enc = new TextEncoder();

async function importKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function b64url(input: ArrayBuffer | Uint8Array): string {
  return Buffer.from(input instanceof Uint8Array ? input : new Uint8Array(input)).toString("base64url");
}

function unb64url(input: string): Uint8Array {
  return Uint8Array.from(Buffer.from(input, "base64url"));
}

export async function signToken(payload: object, ttlSeconds: number): Promise<string> {
  const cfg = getConfig();
  const now = Math.floor(Date.now() / 1000);
  const body = {
    ...payload,
    iat: now,
    exp: now + ttlSeconds,
  };
  const header = { alg: "HS256", typ: "JWT" };
  const headerPart = b64url(enc.encode(JSON.stringify(header)));
  const bodyPart = b64url(enc.encode(JSON.stringify(body)));
  const signingInput = `${headerPart}.${bodyPart}`;
  const key = await importKey(cfg.AUTH_JWT_SECRET);
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(signingInput));
  return `${signingInput}.${b64url(signature)}`;
}

export async function verifyToken<T>(token: string): Promise<T & { iat: number; exp: number }> {
  const cfg = getConfig();
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [headerPart, bodyPart, signaturePart] = parts;
  void headerPart;
  const payload = JSON.parse(Buffer.from(unb64url(bodyPart)).toString("utf8")) as T & { iat?: number; exp?: number };
  if (typeof payload.exp !== "number" || typeof payload.iat !== "number") {
    throw new Error("token missing iat/exp");
  }
  if (payload.exp * 1000 <= Date.now()) throw new Error("token expired");
  const signingInput = `${headerPart}.${bodyPart}`;
  const key = await importKey(cfg.AUTH_JWT_SECRET);
  const valid = await crypto.subtle.verify("HMAC", key, unb64url(signaturePart), enc.encode(signingInput));
  if (!valid) throw new Error("bad signature");
  return payload as T & { iat: number; exp: number };
}

export function mintSessionToken(claims: { sub: string; phone: string }): Promise<string> {
  return signToken(
    { typ: "session", sub: claims.sub, phone: claims.phone },
    getConfig().SESSION_TTL_DAYS * 86_400,
  );
}

export function mintSignupToken(claims: { phone: string; otp_request_id: string }): Promise<string> {
  return signToken(
    { typ: "signup", phone: claims.phone, otp_request_id: claims.otp_request_id },
    getConfig().SIGNUP_TOKEN_TTL_MINUTES * 60,
  );
}