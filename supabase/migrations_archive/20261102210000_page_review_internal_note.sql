-- Staff's own note on a public page (context for whoever reviews it next). page_reviews is staff-only:
-- RLS on, no grants to anon/authenticated (20261101120000_page_reviews), so the note never reaches the public.
ALTER TABLE page_reviews
  ADD COLUMN IF NOT EXISTS internal_note text,
  ADD COLUMN IF NOT EXISTS internal_note_by uuid,
  ADD COLUMN IF NOT EXISTS internal_note_at timestamptz;
