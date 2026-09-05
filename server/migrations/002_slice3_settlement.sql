-- 002_slice3_settlement.sql
-- Slice 3 (trust engine): settlement bookkeeping, spoof-guard state, ledger append-only guard.
--
-- going.settlement_kind / settled_at — every Going row ends in exactly one
-- outcome (spec §2e/§5): showup | no_show | soft_no_show | free_cancel | unverifiable.
-- Ledger rows are written only for point-moving outcomes (showup/no_show/
-- soft_no_show, plus the first_checkin marker); free_cancel and unverifiable
-- carry 0 points so they live on the Going row only (spec §4 has no ledger
-- kinds for them).
-- user_location_fixes — last ACCEPTED fix per user, for the >300 km/h
-- implausible-fix spoof guard (spec §2e). First fix is always accepted.
-- reputation_ledger append-only — Slice 1 left this as a comment; enforced
-- here with a trigger (row-level only, so TRUNCATE in test fixtures still works).

ALTER TABLE going
  ADD COLUMN IF NOT EXISTS settlement_kind text
    CHECK (settlement_kind IN ('showup', 'no_show', 'soft_no_show', 'free_cancel', 'unverifiable'));
ALTER TABLE going
  ADD COLUMN IF NOT EXISTS settled_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_going_unsettled ON going (event_id) WHERE settled_at IS NULL;

CREATE TABLE IF NOT EXISTS user_location_fixes (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  lat         double precision NOT NULL,
  lon         double precision NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION forbid_reputation_ledger_mutation()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'reputation_ledger is append-only (no UPDATE/DELETE), offending % on id %',
    TG_OP, COALESCE(OLD.id::text, NEW.id::text);
  RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_reputation_ledger_append_only ON reputation_ledger;
CREATE TRIGGER trg_reputation_ledger_append_only
  BEFORE UPDATE OR DELETE ON reputation_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_reputation_ledger_mutation();
