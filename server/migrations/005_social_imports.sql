-- 005_social_imports.sql — REVAMP 3: "Bring your nights" social import.
--
-- A user imports up to 3 public posts from other platforms (IG/X/TikTok),
-- each attached to ONE real spot they have actually been to (owner directive
-- 2026-09-09). Honesty rules baked in:
--   * provenance is stored (platform + source_url + media/caption) — nothing
--     is fabricated server-side and no external post content is fetched;
--   * been_there_kind = 'checkin' → the row references a REAL verified
--     check-in the user holds at that spot — never auto-asserted;
--   * been_there_kind = 'claim'   → the user explicitly claimed it; the trust
--     engine later flips claim_status pending → verified/rejected.
CREATE TABLE IF NOT EXISTS imported_posts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  spot_id         uuid NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  platform        text NOT NULL CHECK (platform IN ('instagram', 'x', 'tiktok', 'other')),
  source_url      text NOT NULL CHECK (char_length(source_url) BETWEEN 1 AND 2048),
  media_url       text CHECK (media_url IS NULL OR char_length(media_url) BETWEEN 1 AND 2048),
  caption         text CHECK (caption IS NULL OR char_length(caption) BETWEEN 1 AND 140),
  been_there_kind text NOT NULL CHECK (been_there_kind IN ('checkin', 'claim')),
  check_in_id     uuid REFERENCES checkins(id) ON DELETE SET NULL,
  claim_status    text NOT NULL DEFAULT 'pending'
                  CHECK (claim_status IN ('pending', 'verified', 'rejected')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_url)  -- the same post cannot be imported twice
);
CREATE INDEX IF NOT EXISTS idx_imported_posts_user ON imported_posts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_imported_posts_spot ON imported_posts (spot_id, created_at DESC);

-- Hard per-user cap (3) enforced in the DB as well as the API, so a race can
-- never exceed it. The API pre-checks and returns a clean 409; the trigger is
-- the airtight backstop (23514 → 400 via the shared error mapper).
CREATE OR REPLACE FUNCTION enforce_imported_posts_cap()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM imported_posts WHERE user_id = NEW.user_id;
  IF n > 3 THEN
    RAISE EXCEPTION 'import cap exceeded: max 3 imported posts per user'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_imported_posts_cap ON imported_posts;
CREATE TRIGGER trg_imported_posts_cap
  AFTER INSERT ON imported_posts
  FOR EACH ROW EXECUTE FUNCTION enforce_imported_posts_cap();