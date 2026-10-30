-- What the Worker posted about each meeting to each outside channel (Discord
-- first; issue #67), so re-runs edit the original message instead of posting
-- twice. Holds meeting IDs, channel message IDs and a payload hash only: no
-- webhook URLs, tokens or resident data. Safe to apply while posting is off
-- (DISCORD_POSTS_ENABLED="false"): it creates an empty, service-role-only
-- table and changes no existing object. The Worker posts nothing without it.
CREATE TABLE IF NOT EXISTS public.channel_posts (
  meeting_id bigint NOT NULL REFERENCES public.meetings(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel ~ '^[a-z][a-z0-9_-]{0,31}$'),
  message_id text CHECK (message_id IS NULL OR length(message_id) <= 64),
  posted_at timestamptz,
  payload_hash text CHECK (payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('posted', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, channel)
);
CREATE INDEX IF NOT EXISTS channel_posts_channel_updated_idx
  ON public.channel_posts (channel, updated_at DESC);
ALTER TABLE public.channel_posts ENABLE ROW LEVEL SECURITY;
-- No policies: only the service role (which bypasses RLS) may read or write.
REVOKE ALL ON TABLE public.channel_posts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.channel_posts TO service_role;
