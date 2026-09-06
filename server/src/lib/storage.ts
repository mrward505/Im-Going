import { mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { getConfig, type Config } from "../env";

/**
 * Media storage abstraction (spec §2f: upload to object storage, store the key,
 * serve via public URL). MVP/dev ships a LOCAL provider: files land under
 * STORAGE_LOCAL_DIR (default ./data/uploads, git-ignored) and are served by
 * the API itself at /api/v1/media/:key. Swapping to a real S3/R2 provider is a
 * config change only — implement StorageProvider and select it via
 * STORAGE_PROVIDER (env.ts) — no route changes.
 *
 * Wire contract (both providers honour it):
 *  - requestUploadUrl({ content_type, ext, kind }) → { object_key, upload_url, method, headers, expires_at }
 *  - getPublicUrl(object_key) → URL string the client renders from
 */

export interface UploadUrlRequest {
  content_type: "image/jpeg" | "image/png" | "image/heic" | "video/mp4" | "video/quicktime";
  /** File extension hint used for local key generation (no leading dot). */
  ext?: string;
  /** Kind of media — only affects key layout today. */
  kind?: "post" | "avatar";
}

export interface UploadUrlResponse {
  object_key: string;
  upload_url: string;
  method: "PUT";
  headers: Record<string, string>;
  expires_at: string;
}

export interface StorageProvider {
  readonly name: string;
  requestUploadUrl(req: UploadUrlRequest, userId: string): Promise<UploadUrlResponse>;
  /** Resolve an object key to a fetchable URL (or null if the key is not ours). */
  getPublicUrl(objectKey: string): string | null;
  /** Local provider only: persist uploaded bytes under the key. */
  putObject?(objectKey: string, bytes: Uint8Array, contentType: string): void;
  /** Local provider only: read bytes back for serving. */
  getObject?(objectKey: string): { bytes: Uint8Array; contentType: string } | null;
}

// --- local/dev provider -------------------------------------------------------

const UPLOAD_TTL_MS = 15 * 60_000;
/** Keys we mint locally: posts/<userId-uuid>/<16-hex>.<ext> — nothing else serves. */
const LOCAL_KEY_RE = /^posts\/[0-9a-f-]{36}\/[0-9a-f]{16}\.(jpg|png|heic|mp4|mov)$/;

/**
 * Address of the running Fastify server, set by index.ts at listen time. The
 * local provider's public URLs derive from it so tests (port 0) and dev both
 * produce fetchable links; PUBLIC_API_ORIGIN overrides for production.
 */
let currentServerAddress: { port: number } | null = null;
export function setServerAddress(addr: { port: number } | null): void {
  currentServerAddress = addr;
}
function serverAddress(): { port: number } | null {
  return currentServerAddress;
}

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

function safeExt(req: UploadUrlRequest): string {
  if (req.ext && /^[a-z0-9]{2,5}$/.test(req.ext)) return req.ext;
  return EXT_BY_CONTENT_TYPE[req.content_type] ?? "bin";
}

/** Only keys in the exact shape we mint are readable/writable on the local provider. */
export function isLocalObjectKey(key: string): boolean {
  return LOCAL_KEY_RE.test(key);
}

class LocalStorageProvider implements StorageProvider {
  readonly name = "local";
  private baseDir: string;
  private publicOrigin: string;

  constructor(cfg: Config) {
    this.baseDir = path.resolve(cfg.STORAGE_LOCAL_DIR ?? "./data/uploads");
    // PUBLIC_API_ORIGIN pins the URL base behind proxies/ports. When unset we
    // build URLs at call time from the live listener (correct under tests,
    // which bind port 0, and on the standard local port in dev).
    this.publicOrigin = process.env.PUBLIC_API_ORIGIN ?? "";
    mkdirSync(this.baseDir, { recursive: true });
  }

  /** URL base: pinned origin when set, else the live Fastify listener address. */
  private baseUrl(): string {
    if (this.publicOrigin) return this.publicOrigin;
    const addr = serverAddress();
    return `http://127.0.0.1:${addr?.port ?? 8081}`;
  }

  async requestUploadUrl(req: UploadUrlRequest, userId: string): Promise<UploadUrlResponse> {
    const ext = safeExt(req);
    // Key layout: posts/<userId>/<16-hex>.<ext> — one dir per poster, no
    // user-controlled path components, collision-safe.
    const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 8) + Date.now().toString(16).padStart(8, "0");
    const objectKey = `posts/${userId}/${rand.slice(0, 16)}.${ext}`;
    return {
      object_key: objectKey,
      upload_url: `${this.baseUrl()}/api/v1/media/upload/${objectKey.split("/").map(encodeURIComponent).join("/")}`,
      method: "PUT",
      headers: { "content-type": req.content_type },
      expires_at: new Date(UPLOAD_TTL_MS + Date.now()).toISOString(),
    };
  }

  getPublicUrl(objectKey: string): string | null {
    if (!isLocalObjectKey(objectKey)) return null;
    return `${this.baseUrl()}/api/v1/media/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
  }

  putObject(objectKey: string, bytes: Uint8Array, _contentType: string): void {
    if (!isLocalObjectKey(objectKey)) throw new Error(`refusing to write unrecognised key: ${objectKey}`);
    const target = path.resolve(this.baseDir, objectKey);
    if (!target.startsWith(this.baseDir + path.sep)) throw new Error("key escapes the uploads dir");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }

  getObject(objectKey: string): { bytes: Uint8Array; contentType: string } | null {
    if (!isLocalObjectKey(objectKey)) return null;
    const target = path.resolve(this.baseDir, objectKey);
    if (!target.startsWith(this.baseDir + path.sep)) return null;
    if (!existsSync(target) || !statSync(target).isFile()) return null;
    const bytes = new Uint8Array(readFileSync(target));
    const contentType = CONTENT_TYPE_BY_EXT[path.extname(target).slice(1)] ?? "application/octet-stream";
    return { bytes, contentType };
  }
}

let provider: StorageProvider | undefined;

/** Storage provider for the current config (cached). */
export function getStorage(): StorageProvider {
  if (!provider) {
    const cfg = getConfig();
    switch (cfg.STORAGE_PROVIDER) {
      // Unknown provider names fall back to local so dev never hard-fails;
      // real cloud providers slot in here as new cases.
      case "local":
      default:
        provider = new LocalStorageProvider(cfg);
    }
  }
  return provider;
}

/** Test seam: force a provider instance (tests pass a stub or reset). */
export function setStorage(p: StorageProvider | undefined): void {
  provider = p;
}
