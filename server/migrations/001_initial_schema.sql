-- 001_initial_schema.sql
-- I'm Going MVP — schema per product-spec.md §4 DATA MODEL (slice 1).
-- All spec field names are used verbatim. "Enums" are TEXT + CHECK constraints.

-- App infrastructure (not spec entities) --------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()
-- PostGIS is a geospatial optimization (spec §4 wants a geospatial index).
-- It is optional: a plain (lat, lon) btree index is created below instead
-- when PostGIS is unavailable (e.g. Neon free tier). Haversine math in the
-- API stays authoritative either way.
CREATE EXTENSION IF NOT EXISTS postgis;

-- Phone OTP request log (supports spec §2a SMS OTP flow)
CREATE TABLE IF NOT EXISTS phone_otp_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       text NOT NULL,                 -- E.164
  code_hash   text NOT NULL,                 -- SHA-256 of the 6-digit code (home-rolled, no secrets)
  provider    text NOT NULL DEFAULT 'console',
  attempts    int  NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_phone_otp_requests_phone ON phone_otp_requests (phone, created_at DESC);

-- Spec §4: User ----------------------------------------------------------
-- is_minor deliberately ABSENT (MVP is 18+; a later 14+ expansion adds teen tiers).
CREATE TABLE IF NOT EXISTS users (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone                     text NOT NULL UNIQUE CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  dob                       date NOT NULL,
  display_name              text NOT NULL,
  username                  text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_]{3,20}$'),
  city                      text NOT NULL DEFAULT 'Tempe',
  reputation_points         int  NOT NULL DEFAULT 500 CHECK (reputation_points BETWEEN 0 AND 1000),
  star_rating               numeric(3,1) NOT NULL DEFAULT 3.0 CHECK (star_rating BETWEEN 1.0 AND 5.0), -- derived/cached
  verified_checkin_count    int  NOT NULL DEFAULT 0,
  location_permission_granted bool NOT NULL DEFAULT false, -- cached
  shares_today              int  NOT NULL DEFAULT 0,        -- share rate limit counter (§2g)
  shares_date               date,                           -- UTC day the counter applies to
  created_at                timestamptz NOT NULL DEFAULT now(),
  deleted_at                timestamptz                     -- nullable soft-delete
);

-- Spec §4: Spot ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS spots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  address          text,
  lat              double precision NOT NULL,
  lon              double precision NOT NULL,
  geofence_radius_m int NOT NULL DEFAULT 150,
  category         text NOT NULL CHECK (category IN ('bar', 'club', 'concert', 'restaurant', 'house', 'other')),
  is_verified      boolean NOT NULL DEFAULT true,     -- POI-seeded vs custom
  is_large_venue   boolean NOT NULL DEFAULT false,
  city             text NOT NULL DEFAULT 'Tempe',
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL, -- null for seed venues
  created_at       timestamptz NOT NULL DEFAULT now()
);
-- Spec §4: "Index: geospatial on (lat, lon) + city."
CREATE INDEX IF NOT EXISTS idx_spots_city ON spots (city);
CREATE INDEX IF NOT EXISTS idx_spots_latlon ON spots (lat, lon);
-- PostGIS-only geospatial index (optional; skipped when the extension is absent).
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_spots_geog ON spots USING gist (ST_SetSRID(ST_MakePoint(lon, lat), 4326))';
  END IF;
END $do$;

-- Spec §4: Event ---------------------------------------------------------
-- default_end = start_at + 4 h. Postgres rejects start_at + INTERVAL as a
-- GENERATED column ("generation expression is not immutable": timestamptz +
-- interval is timezone-dependent), so the 4 h end is computed by a BEFORE
-- trigger instead — same semantics, DB-enforced.
CREATE TABLE IF NOT EXISTS events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spot_id    uuid NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
  start_at   timestamptz NOT NULL,
  default_end timestamptz NOT NULL,
  note       text CHECK (char_length(note) <= 140),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Set default_end = start_at + 4 h on insert and whenever start_at moves.
CREATE OR REPLACE FUNCTION events_set_default_end()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW.default_end := NEW.start_at + INTERVAL '4 hours';
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_events_set_default_end ON events;
CREATE TRIGGER trg_events_set_default_end
  BEFORE INSERT OR UPDATE OF start_at ON events
  FOR EACH ROW EXECUTE FUNCTION events_set_default_end();
-- MVP snaps users to the earliest event that day on a spot.
CREATE INDEX IF NOT EXISTS idx_events_spot_start ON events (spot_id, start_at);
CREATE INDEX IF NOT EXISTS idx_events_start ON events (start_at);

-- Spec §4: Going (attendance intent) -------------------------------------
CREATE TABLE IF NOT EXISTS going (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, user_id)
);

-- Spec §4: CheckIn (verification) ----------------------------------------
CREATE TABLE IF NOT EXISTS checkins (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  spot_id     uuid NOT NULL REFERENCES spots(id) ON DELETE CASCADE, -- denorm
  verified_at timestamptz NOT NULL DEFAULT now(),                  -- server clock
  method      text NOT NULL CHECK (method IN ('manual_gps', 'passive')),
  lat         double precision NOT NULL,
  lon         double precision NOT NULL,
  accuracy_m  double precision NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, user_id) -- one check-in per (user, event)
);

-- Spec §4: Post/Media ----------------------------------------------------
CREATE TABLE IF NOT EXISTS posts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  check_in_id uuid NOT NULL REFERENCES checkins(id) ON DELETE CASCADE, -- required: no check-in, no post
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  spot_id     uuid NOT NULL REFERENCES spots(id) ON DELETE CASCADE,     -- denorm for feed
  type        text NOT NULL CHECK (type IN ('image', 'video')),
  caption     text CHECK (char_length(caption) <= 140),
  object_key  text NOT NULL,
  width       int,
  height      int,
  duration_s  int,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (check_in_id) -- spec §4: CheckIn 1—1 Post at most
);
-- Spec §4: Index: (spot_id, created_at desc)
CREATE INDEX IF NOT EXISTS idx_posts_spot_created ON posts (spot_id, created_at DESC);

-- Spec §4: ReputationLedger (event log — source of truth for stars) ------
CREATE TABLE IF NOT EXISTS reputation_ledger (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('showup', 'no_show', 'soft_no_show', 'first_checkin', 'admin_adjust')),
  points_delta int NOT NULL,
  event_id     uuid REFERENCES events(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reputation_ledger_user ON reputation_ledger (user_id, created_at DESC);
-- Append-only is a Slice 3 DB-enforced guard (triggers/RLS).

-- Spec §4: ModerationReport ----------------------------------------------
CREATE TABLE IF NOT EXISTS moderation_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id     uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  reason      text NOT NULL CHECK (reason IN ('spam', 'harassment', 'nudity', 'violence', 'other')),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_moderation_reports_status ON moderation_reports (status, created_at);