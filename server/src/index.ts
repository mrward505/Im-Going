/**
 * I'm Going API — entrypoint (slices 1–3 foundation; slice 1 ships health,
 * auth OTP stub, spots/events CRUD scaffold, geofence + reputation libs).
 */
import Fastify from "fastify";
import { loadConfig, getConfig } from "./env";
import { getPool, closePool, ping } from "./db/pool";
import { migrateUp } from "./db/migrate";
import { registerAuthRoutes } from "./routes/auth";
import { registerSpotRoutes } from "./routes/spots";
import { registerVenueRoutes } from "./routes/venues";
import { registerEventRoutes } from "./routes/events";
import { registerCheckinRoutes } from "./routes/checkins";
import { registerPostRoutes } from "./routes/posts";
import { registerInviteRoutes } from "./routes/invites";
import { registerImportRoutes } from "./routes/imports";
import { registerTrendingRoutes, registerShareRoutes } from "./routes/trending";
import { toApiError } from "./lib/errors";
import { setServerAddress } from "./lib/storage";
import { verifyToken, type SafeUserClaims } from "./lib/tokens";

declare module "fastify" {
  interface FastifyRequest {
    userClaims?: SafeUserClaims;
  }
  interface FastifyInstance {
    authenticate: (req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void>;
  }
}

export async function buildApp() {
  const cfg = getConfig();
  const app = Fastify({
    logger: { level: cfg.LOG_LEVEL, transport: undefined },
    disableRequestLogging: true,
  });

  // Attach optional JWT claims to every request (401 only where required).
  app.decorateRequest("userClaims", undefined);
  app.addHook("onRequest", async (req) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return;
    try {
      const claims = await verifyToken<SafeUserClaims>(header.slice(7));
      if (claims.typ === "session") req.userClaims = claims;
    } catch {
      req.log.warn({ err: "bad_auth_header" }, "ignoring invalid bearer token");
    }
  });

  // preHandler helper: require a valid session.
  app.decorate("authenticate", async (req, reply) => {
    if (!req.userClaims) {
      return reply.code(401).send({ error: { code: "unauthorized", message: "authentication required" } });
    }
  });

  // CORS (dev allow-list): the Expo web preview (localhost:8082) calls this
  // API from the browser, so preflights + credentialed cross-origin reads need
  // explicit headers. Prod stays strict: only origins in CORS_ORIGINS (comma
  // separated) or the localhost dev defaults below ever get headers.
  const corsOrigins = new Set(
    (process.env.CORS_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\/$/, ""))
      .filter(Boolean)
      .concat([
        "http://localhost:8082",
        "http://localhost:8081",
        "http://127.0.0.1:8082",
        "http://127.0.0.1:8081",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
      ]),
  );
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (typeof origin === "string" && corsOrigins.has(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "Origin");
      reply.header("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
      reply.header("access-control-allow-headers", "content-type, authorization");
      reply.header("access-control-max-age", "86400");
      if (req.method === "OPTIONS") return reply.code(204).send();
    }
  });

  // Health (no auth; proves DB reachability).
  app.get("/health", async (_req, reply) => {
    try {
      await ping();
      return reply.send({
        status: "ok",
        service: "imgoing-api",
        version: "0.1.0",
        db: "ok",
        time: new Date().toISOString(),
        city: cfg.LAUNCH_CITY,
      });
    } catch (err) {
      app.log.error({ err: (err as Error).message }, "health db check failed");
      return reply.code(503).send({ status: "degraded", db: "error" });
    }
  });

  void migrateUp().catch((err) => {
    app.log.error({ err: (err as Error).message }, "migration run skipped/failed on boot (will retry via bun run migrate)");
  });

  await registerAuthRoutes(app);
  await registerSpotRoutes(app);
  await registerVenueRoutes(app);
  await registerEventRoutes(app);
  await registerCheckinRoutes(app);
  await registerPostRoutes(app);
  await registerInviteRoutes(app);
  await registerImportRoutes(app);
  await registerTrendingRoutes(app);
  await registerShareRoutes(app);

  // Central error handler → { error: { code, message } }.
  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, "request error");
    const e = toApiError(err);
    return reply.code(e.statusCode).send({ error: { code: e.code, message: e.message } });
  });

  // 404s match the same shape.
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: { code: "not_found", message: "route not found" } }),
  );

  return app;
}

export async function start(): Promise<void> {
  const app = await buildApp();
  const cfg = getConfig();
  const port = cfg.PORT;
  const host = cfg.HOST;
  await app.listen({ port, host });
  setServerAddress(app.server.address() as { port: number } | null);
  app.log.info({ port, host }, "imgoing-api listening");
}

if (import.meta.main) {
  loadConfig(); // fail fast on bad config
  start().catch((err) => {
    console.error("failed to start:", err);
    process.exit(1);
  });
}

// Graceful shutdown.
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
async function shutdown(sig: string): Promise<void> {
  console.log(`received ${sig}, shutting down`);
  await closePool().catch(() => undefined);
  process.exit(0);
}

void getPool; // keep import linked for typecheck clarity
void ping;