-- Contact form submissions from /contact
CREATE TABLE IF NOT EXISTS contact_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  email text NOT NULL,
  message text NOT NULL,
  client_ip text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contact_messages_created_at ON contact_messages (created_at DESC);

-- RLS on with no policies: only the service-role (admin) client can read or write.
ALTER TABLE contact_messages ENABLE ROW LEVEL SECURITY;
