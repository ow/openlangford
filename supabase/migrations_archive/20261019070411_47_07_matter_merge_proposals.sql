-- Merge proposals from the matter resolver that need a human decision.
-- Approving one records the merge with the alias convention
-- (alias meta.canonical_matter_id + canonical meta.merged_matter_ids).
CREATE TABLE IF NOT EXISTS matter_merge_proposals (
  id bigserial PRIMARY KEY,
  matter_ids bigint[] NOT NULL,
  decisions jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  source text NOT NULL DEFAULT 'resolver',
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by text
);

CREATE INDEX IF NOT EXISTS matter_merge_proposals_status_idx ON matter_merge_proposals (status, created_at DESC);

-- Admin-only: no public policies; the web app reads it with the service role.
ALTER TABLE matter_merge_proposals ENABLE ROW LEVEL SECURITY;
