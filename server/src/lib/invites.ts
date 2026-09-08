import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";

/**
 * Invite codes — Tempe launch infrastructure (owner decision 2026-09-06):
 * the first wave of users joins only via invite codes, and each influencer
 * gets a personalized code so signups are attributable to the code that
 * drove them. All counts come from real rows — never fabricated.
 */

export interface InviteCodeRow {
  id: string;
  code: string;
  label: string | null;
  max_uses: number;
  used_count: number;
  created_at: string;
}

/** Human-typable alphabet: no 0/O, 1/I/L to avoid read-back errors. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function randomInviteCode(length = 8): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function normalizeInviteCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Mint N fresh codes (collision-safe: unique constraint + retry). */
export async function mintInviteCodes(
  client: Pool | PoolClient,
  opts: { count: number; label?: string | null; maxUses?: number },
): Promise<InviteCodeRow[]> {
  const count = Math.min(Math.max(Math.floor(opts.count), 1), 500);
  const label = opts.label?.trim() ? opts.label.trim().slice(0, 80) : null;
  const maxUses = Math.min(Math.max(Math.floor(opts.maxUses ?? 1), 1), 10_000);
  const minted: InviteCodeRow[] = [];
  for (let i = 0; i < count; i++) {
    // A handful of retries per code; collisions are ~impossible at 8 chars
    // (32^8) but the UNIQUE constraint is the real backstop.
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = randomInviteCode(8);
      try {
        const { rows } = await client.query<InviteCodeRow>(
          `INSERT INTO invite_codes (code, label, max_uses) VALUES ($1, $2, $3)
           RETURNING id, code, label, max_uses, used_count, created_at::text AS created_at`,
          [code, label, maxUses],
        );
        minted.push(rows[0]);
        break;
      } catch (err) {
        if ((err as { code?: string }).code === "23505" && attempt < 9) continue;
        throw err;
      }
    }
  }
  return minted;
}

export interface InviteStatus extends InviteCodeRow {
  remaining: number;
  spent: boolean;
  redeemers: { user_id: string; username: string | null; created_at: string }[];
}

export async function listInviteCodes(client: Pool | PoolClient): Promise<InviteStatus[]> {
  const { rows: codes } = await client.query<InviteCodeRow>(
    `SELECT id, code, label, max_uses, used_count, created_at::text AS created_at
     FROM invite_codes ORDER BY created_at DESC`,
  );
  const { rows: reds } = await client.query<{
    code_id: string;
    user_id: string;
    username: string | null;
    created_at: string;
  }>(
    `SELECT r.code_id, r.user_id, u.username, r.created_at::text AS created_at
     FROM invite_redemptions r LEFT JOIN users u ON u.id = r.user_id
     ORDER BY r.created_at`,
  );
  const byCode = new Map<string, InviteStatus["redeemers"]>();
  for (const r of reds) {
    const list = byCode.get(r.code_id) ?? [];
    list.push({ user_id: r.user_id, username: r.username, created_at: r.created_at });
    byCode.set(r.code_id, list);
  }
  return codes.map((c) => ({
    ...c,
    remaining: Math.max(c.max_uses - c.used_count, 0),
    spent: c.used_count >= c.max_uses,
    redeemers: byCode.get(c.id) ?? [],
  }));
}
