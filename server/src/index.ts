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
import { toApiError } from "./lib/errors";
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