import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool";
import { getConfig } from "../env";
import { forbidden } from "../lib/errors";
import { mintInviteCodes, listInviteCodes } from "../lib/invites";

/**
 * Admin invite endpoints — the team's minting + inspection console for the
 * Tempe launch (influencer outreach hands each influencer a personalized
 * code; generic batches cover the owner's network).
 *
 * Auth: the codebase has no admin role, so this matches existing privileged-op
 * practice — there is none yet, so the rule is explicit and minimal:
 *   - if ADMIN_TOKEN is set, the request must carry
 *     `Authorization: Bearer <ADMIN_TOKEN>`;
 *   - if ADMIN_TOKEN is NOT set (local dev / test), the endpoints are open
 *     so the team can mint without ceremony. Production MUST set ADMIN_TOKEN
 *     (asserted at boot when NODE_ENV=production).
 */
export function requireAdmin(req: { headers: Record<string, unknown> }): void {
  const configured = getConfig().ADMIN_TOKEN;
  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw forbidden("admin endpoints require ADMIN_TOKEN in production");
    }
    return; // local dev / test: open, like OTP console codes
  }
  const header = req.headers.authorization;
  const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || token !== configured) throw forbidden("admin token required");
}

const mintSchema = z.object({
  count: z.number().int().min(1).max(500).default(1),
  label: z.string().trim().min(1).max(80).nullish(),
  max_uses: z.number().int().min(1).max(10_000).nullish(),
});

export async function registerInviteRoutes(app: FastifyInstance): Promise<void> {
  const pool = getPool();

  // Mint a batch of codes. { count, label?, max_uses? } → { codes: [...] }.
  app.post("/api/v1/admin/invites/mint", async (req, reply) => {
    requireAdmin(req as { headers: Record<string, unknown> });
    const { count, label, max_uses } = mintSchema.parse(req.body);
    const codes = await mintInviteCodes(pool, {
      count,
      label: label ?? null,
      maxUses: max_uses ?? 1,
    });
    return reply.code(201).send({ codes });
  });

  // Inspect every code with used/unused status + redeemers (real rows only).
  app.get("/api/v1/admin/invites", async (req, reply) => {
    requireAdmin(req as { headers: Record<string, unknown> });
    const codes = await listInviteCodes(pool);
    return reply.send({ codes });
  });
}
