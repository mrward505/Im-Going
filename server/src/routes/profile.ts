import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool";
import { findUserById, serializeUser } from "../db";
import { badRequest, unauthorized } from "../lib/errors";
import { getStorage, isAvatarObjectKey, objectKeyOwner } from "../lib/storage";

/**
 * REVAMP 5 — profile pictures (owner 2026-09-11: "I should be able to add a
 * profile picture"). The upload contract already minted keys with
 * kind:"avatar"; these routes are the second half:
 *
 *   PATCH  /api/v1/me/avatar { object_key } → set my picture
 *   DELETE /api/v1/me/avatar                → clear it (back to initials)
 *
 * The client flow is the same closed loop as event posts: requestUploadUrl
 * (kind:"avatar") → PUT the bytes → PATCH the returned object_key. The server
 * stores BOTH the storage key (single source of truth) and the resolved public
 * URL (captured at write time so every identity serializer stays
 * storage-agnostic). Real uploads only: the key must live in the caller's own
 * avatars/ namespace AND resolve on the active storage provider — no
 * placeholder or foreign URLs can be set.
 */
const avatarBodySchema = z.object({
  object_key: z.string().min(1).max(512),
});

export async function registerProfileRoutes(app: FastifyInstance): Promise<void> {
  const pool = getPool();

  app.patch("/api/v1/me/avatar", {
    preHandler: app.authenticate,
  }, async (req, reply) => {
    const claims = req.userClaims!;
    const { object_key } = avatarBodySchema.parse(req.body ?? {});

    // Ownership: the key must be one WE minted, in the caller's avatars/ dir.
    if (!isAvatarObjectKey(object_key) || objectKeyOwner(object_key) !== claims.sub) {
      throw badRequest("unknown object_key — request an avatar upload URL first");
    }
    const avatarUrl = getStorage().getPublicUrl(object_key);
    if (!avatarUrl) throw badRequest("unknown object_key — request an avatar upload URL first");

    const { rows } = await pool.query<{ id: string }>(
      `UPDATE users SET avatar_object_key = $2, avatar_url = $3 WHERE id = $1 AND deleted_at IS NULL
       RETURNING id`,
      [claims.sub, object_key, avatarUrl],
    );
    if (!rows[0]) throw unauthorized("authentication required");
    const user = await findUserById(pool, claims.sub);
    if (!user) throw unauthorized("authentication required");
    return reply.send({ user: serializeUser(user) });
  });

  app.delete("/api/v1/me/avatar", {
    preHandler: app.authenticate,
  }, async (req, reply) => {
    const claims = req.userClaims!;
    const { rows } = await pool.query<{ id: string }>(
      `UPDATE users SET avatar_object_key = NULL, avatar_url = NULL
       WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [claims.sub],
    );
    if (!rows[0]) throw unauthorized("authentication required");
    const user = await findUserById(pool, claims.sub);
    if (!user) throw unauthorized("authentication required");
    return reply.send({ user: serializeUser(user) });
  });
}
