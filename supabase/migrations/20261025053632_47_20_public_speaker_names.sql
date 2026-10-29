-- Names public speakers gave on the recording, and how each was decided.
-- The participation stage writes one row per (agenda item, introduced name);
-- admins resolve 'review' rows in /admin/names. Decided rows are never
-- overwritten by the pipeline.
CREATE TABLE IF NOT EXISTS public_speaker_names (
  id bigserial PRIMARY KEY,
  municipality_id bigint NOT NULL DEFAULT 1,
  meeting_id bigint NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  agenda_item_id bigint NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  name_key text NOT NULL,
  transcribed_name text NOT NULL,
  display_name text,
  status text NOT NULL CHECK (status IN ('published', 'review', 'anonymous')),
  basis text NOT NULL CHECK (basis IN ('registry', 'minutes', 'known', 'introduction', 'admin')),
  conflict jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_segment_ids bigint[] NOT NULL DEFAULT '{}',
  start_time double precision,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agenda_item_id, name_key)
);

CREATE INDEX IF NOT EXISTS public_speaker_names_status_idx ON public_speaker_names (status, created_at);
CREATE INDEX IF NOT EXISTS public_speaker_names_meeting_idx ON public_speaker_names (meeting_id);

-- Admin-only: no public policies; the pipeline and admin pages use the service role.
ALTER TABLE public_speaker_names ENABLE ROW LEVEL SECURITY;
