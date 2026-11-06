-- When public content last changed, so the web Worker can cache pages and public data for a day
-- and still pick up an ingest, a correction or an admin edit within about a minute: the Worker
-- reads changed_at (at most once a minute per isolate) and puts it in every cache key.
--
-- Statement-level triggers on the tables public pages read. The UPDATE only matches when the
-- stamp is over a minute old, so a busy ingest writes this row at most once a minute.

create table if not exists public.public_content_version (
  id smallint primary key default 1 check (id = 1),
  changed_at timestamptz not null default now()
);
insert into public.public_content_version (id) values (1) on conflict (id) do nothing;
alter table public.public_content_version enable row level security;

create or replace function public.touch_public_content_version() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.public_content_version set changed_at = now()
  where id = 1 and changed_at < now() - interval '1 minute';
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'meetings', 'agenda_items', 'agenda_item_topics', 'motions', 'votes', 'attendance', 'matters', 'matter_links',
    'matter_evidence', 'people', 'memberships', 'organizations', 'council_terms', 'documents', 'extracted_documents',
    'document_sections', 'document_images', 'bylaws', 'properties', 'property_links', 'transcript_segments',
    'key_statements', 'key_votes', 'meeting_events', 'meeting_speaker_aliases', 'meeting_slug_history',
    'councillor_stances', 'councillor_highlights', 'elections', 'election_offices', 'candidacies', 'topics',
    'public_speaker_names', 'municipalities'
  ] loop
    execute format('drop trigger if exists touch_public_content_version on public.%I', t);
    execute format('create trigger touch_public_content_version after insert or update or delete or truncate on public.%I
                    for each statement execute function public.touch_public_content_version()', t);
  end loop;
end $$;
