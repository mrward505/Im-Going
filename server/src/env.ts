import assert from "node:assert";

/**
 * Environment loading with a pragmatic portable fallback: if the process
 * (or a .env file) did not provide DATABASE_URL / AUTH_JWT_SECRET, read the
 * canonical local dev values (see scripts/dev-db.sh + .env.example) so the
 * repo boots out of the box for the team. Never used in production — real
 * prod starts with production env vars only.
 */
let cached: Config | undefined;

function readDotEnv(): Record<string, string> {
  try {
    const text = require("node:fs").readFileSync(new URL("../.env", import.meta.url), "utf8");
    const out: Record<string, string> = {};
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export interface Config {
  DATABASE_URL: string;
  PORT: number;
  HOST: string;
  LOG_LEVEL: string;
  OTP_PROVIDER: "console" | "twilio";
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_VERIFY_SERVICE_SID?: string;
  OTP_TTL_SECONDS: number;
  OTP_MAX_ATTEMPTS: number;
  AUTH_JWT_SECRET: string;
  SESSION_TTL_DAYS: number;
  SIGNUP_TOKEN_TTL_MINUTES: number;
  STORAGE_PROVIDER: string;
  STORAGE_BUCKET?: string;
  STORAGE_LOCAL_DIR?: string;
  LAUNCH_CITY: string;
}

function intOr(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const dot = readDotEnv();
  const get = (key: string): string | undefined => env[key] ?? dot[key];

  const DATABASE_URL =
    get("DATABASE_URL") ??
    // Portable local-dev fallback (also used by automated smoke tests).
    "postgres://imgoing:imgoing_dev_password@127.0.0.1:5432/imgoing";

  const AUTH_JWT_SECRET = get("AUTH_JWT_SECRET") ?? "dev-only-Insecure-1";
  assert(AUTH_JWT_SECRET.length >= 16, "AUTH_JWT_SECRET must be at least 16 characters");
  assert(
    process.env.AUTH_JWT_SECRET !== "dev-only-Insecure-1" || process.env.NODE_ENV !== "production",
    "refusing to boot a production API with the insecure default secret",
  );

  const cfg: Config = {
    DATABASE_URL,
    PORT: intOr(get("PORT"), 8081), // 8080 is reserved on the team dev box by an unrelated local service
    HOST: get("HOST") ?? "127.0.0.1",
    LOG_LEVEL: get("LOG_LEVEL") ?? "info",
    OTP_PROVIDER: (get("OTP_PROVIDER") ?? "console") === "twilio" ? "twilio" : "console",
    TWILIO_ACCOUNT_SID: get("TWILIO_ACCOUNT_SID"),
    TWILIO_AUTH_TOKEN: get("TWILIO_AUTH_TOKEN"),
    TWILIO_VERIFY_SERVICE_SID: get("TWILIO_VERIFY_SERVICE_SID"),
    OTP_TTL_SECONDS: intOr(get("OTP_TTL_SECONDS"), 300),
    OTP_MAX_ATTEMPTS: intOr(get("OTP_MAX_ATTEMPTS"), 5),
    AUTH_JWT_SECRET,
    SESSION_TTL_DAYS: intOr(get("SESSION_TTL_DAYS"), 30),
    SIGNUP_TOKEN_TTL_MINUTES: intOr(get("SIGNUP_TOKEN_TTL_MINUTES"), 15),
    STORAGE_PROVIDER: get("STORAGE_PROVIDER") ?? "local",
    STORAGE_BUCKET: get("STORAGE_BUCKET"),
    STORAGE_LOCAL_DIR: get("STORAGE_LOCAL_DIR") ?? "./data/uploads",
    LAUNCH_CITY: get("LAUNCH_CITY") ?? "Tempe",
  };

  if (cfg.OTP_PROVIDER === "twilio") {
    assert(
      cfg.TWILIO_ACCOUNT_SID && cfg.TWILIO_AUTH_TOKEN && cfg.TWILIO_VERIFY_SERVICE_SID,
      "OTP_PROVIDER=twilio requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID",
    );
  }
  return cfg;
}

export function getConfig(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

// Allow tests to reload config with a custom env.
export function resetConfig(): void {
  cached = undefined;
}