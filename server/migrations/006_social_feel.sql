-- REVAMP 5 — social feel: per-user profile pictures (owner 2026-09-11).
-- Additive only: existing rows keep avatar_object_key/avatar_url NULL and the
-- client falls back to initials. avatar_object_key is the storage-contract key
-- (single source of truth); avatar_url is the resolved public URL captured at
-- write time so every identity serializer stays storage-agnostic.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_object_key text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url text;