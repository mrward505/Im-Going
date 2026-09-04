import { randomInt, createHash, timingSafeEqual } from "node:crypto";
import { getConfig } from "../env";

export const OTP_CODE_LENGTH = 6;

/** Returns a code + its SHA-256 hash. Codes are stored/compared hashed. */
export function issueOtpCode(): { code: string; codeHash: string } {
  const code = String(randomInt(0, 1_000_000)).padStart(OTP_CODE_LENGTH, "0");
  return { code, codeHash: hashOtpCode(code) };
}

export function hashOtpCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** Constant-time comparison of a candidate code against a stored hash. */
export function verifyOtpCode(code: string, codeHash: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const candidate = Buffer.from(hashOtpCode(code), "hex");
  const stored = Buffer.from(codeHash, "hex");
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

/** Compute the expires_at bound for a fresh OTP request. */
export function otpExpiry(now: Date = new Date()): Date {
  const cfg = getConfig();
  return new Date(now.getTime() + cfg.OTP_TTL_SECONDS * 1000);
}

export function isOtpExpired(expiresAt: Date | string, now: Date = new Date()): boolean {
  return new Date(expiresAt).getTime() <= now.getTime();
}