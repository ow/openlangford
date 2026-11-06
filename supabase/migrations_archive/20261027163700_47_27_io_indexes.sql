-- Disk IO: indexes for unindexed foreign keys and the embedding work queue.
--
-- pg_stat_user_tables showed agenda_items with ~402k sequential scans (2.8B tuples read): matter pages
-- and matter stages filter agenda_items by matter_id, and deleting agenda items cascades through the
-- unindexed parent_id self-reference. Deleting a meeting also scanned transcript_segments (58 MB) for
-- every agenda item and motion, because their ON DELETE SET NULL foreign keys had no index.
-- The embeddings stage counts and pages document_sections rows with no embedding (220 MB table).
--
-- CONCURRENTLY: no table locks, so the site and running ingests keep working. Run outside a transaction.

create index concurrently if not exists agenda_items_matter_id_idx on public.agenda_items (matter_id) where matter_id is not null;
create index concurrently if not exists agenda_items_parent_id_idx on public.agenda_items (parent_id) where parent_id is not null;
create index concurrently if not exists transcript_segments_agenda_item_id_idx on public.transcript_segments (agenda_item_id) where agenda_item_id is not null;
create index concurrently if not exists transcript_segments_motion_id_idx on public.transcript_segments (motion_id) where motion_id is not null;
create index concurrently if not exists document_sections_missing_embedding_idx on public.document_sections (id) where embedding is null;
create index concurrently if not exists bylaw_chunks_missing_embedding_idx on public.bylaw_chunks (id) where embedding is null;
create index concurrently if not exists attendance_person_id_idx on public.attendance (person_id);
create index concurrently if not exists meetings_organization_id_idx on public.meetings (organization_id);
