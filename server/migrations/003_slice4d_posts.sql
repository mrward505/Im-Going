-- Slice 4d-1: posts backend.
-- posts/moderation_reports tables already exist (001). The only real schema
-- gap vs the spec is enforcing "one report per (post, reporter)" in the DB —
-- the API enforces it, the constraint makes it airtight.
CREATE UNIQUE INDEX IF NOT EXISTS uq_moderation_reports_post_reporter
  ON moderation_reports (post_id, reporter_id);
