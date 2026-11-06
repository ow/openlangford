-- Review-then-publish for councillor profiles. The pipeline writes drafts;
-- an admin approves them, which copies the draft (and a snapshot of the
-- person's councillor_stances) into the published fields the site reads.
-- A published version stays live while a newer draft awaits review.
ALTER TABLE councillor_highlights
  ADD COLUMN IF NOT EXISTS draft_overview text,
  ADD COLUMN IF NOT EXISTS draft_highlights jsonb,
  ADD COLUMN IF NOT EXISTS draft_generated_at timestamptz,
  ADD COLUMN IF NOT EXISTS draft_evidence jsonb,
  ADD COLUMN IF NOT EXISTS published_stances jsonb,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by text;

-- Published fields are only set on approval; a fresh row is draft-only.
ALTER TABLE councillor_highlights ALTER COLUMN highlights DROP NOT NULL;
ALTER TABLE councillor_highlights ALTER COLUMN highlights DROP DEFAULT;
ALTER TABLE councillor_highlights ALTER COLUMN generated_at DROP NOT NULL;
ALTER TABLE councillor_highlights ALTER COLUMN generated_at DROP DEFAULT;
