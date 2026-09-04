import type { FastifySchema } from "fastify";
import { z } from "zod";
import { badRequest } from "./errors";

/**
 * Fastify's schema compiler only understands JSON Schema. zod objects are
 * NOT valid JSON Schema, so `schema: { body: zodObject }` fails at boot with
 * FST_ERR_SCH_VALIDATION_BUILD. Handlers already `.parse()` with zod, so the
 * Fastify schema option is redundant — we expose runtime validation through
 * expected params only where the route needs them.
 *
 * NOTE: these helpers are optional (params come as strings in Fastify;
 * handlers validate with zod). They exist so route declarations stay
 * self-documenting without breaking the boot.
 */
export function zodParamsSchema<T extends z.ZodTypeAny>(_schema: T): FastifySchema {
  return {}; // validation happens in the handler via .parse()
}

/** Convert a zod validation failure into the API's structured 400. */
export function fromZodError(err: unknown): { statusCode: number; code: string; message: string } {
  if (err instanceof z.ZodError) {
    const first = err.issues[0];
    const message = first ? `${first.path.join(".") || "body"}: ${first.message}` : "invalid request";
    return { statusCode: 400, code: "invalid_request", message };
  }
  return { statusCode: 500, code: "internal", message: "internal error" };
}

export { badRequest };
export type { FastifySchema };