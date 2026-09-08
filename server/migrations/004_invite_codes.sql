-- 004_invite_codes.sql
-- Tempe launch infrastructure (owner decision 2026-09-06): the first 50-200
-- users join only via invite codes, and influencers each get a personalized
-- code they can share so signups are attributable to the code that drove them.
--
-- invite_codes: one row per minted code. `label` is the human owner
-- (e.g. "TempeBarstool", "GiannaLuke"; NULL for generic batches).
-- `max_uses` allows multi-use influencer codes; single-use by default.
-- `used_count` counts redemptions; a code is spent when
-- used_count >= max_uses. `redeemed_by` records the users who joined with
-- the code (influencer attribution), so this is a real join table — no
-- invented numbers anywhere.
CREATE TABLE IF NOT EXISTS invite_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{4,16}$'),
  label       text,
  max_uses    int  NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  used_count  int  NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invite_codes_label ON invite_codes (label);

-- Attribution: which code each user joined with (NULL for pre-invite users).
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_code_id uuid REFERENCES invite_codes(id) ON DELETE SET NULL;

-- Redemptions log: one row per (code, user) redeem. UNIQUE(code_id, user_id)
-- keeps double-redeem by the same user out at the DB level too.
CREATE TABLE IF NOT EXISTS invite_redemptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_id     uuid NOT NULL REFERENCES invite_codes(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_invite_redemptions_code ON invite_redemptions (code_id);
