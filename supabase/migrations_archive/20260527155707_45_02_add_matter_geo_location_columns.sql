ALTER TABLE matters ADD COLUMN IF NOT EXISTS geo_location jsonb;
ALTER TABLE agenda_items ADD COLUMN IF NOT EXISTS geo_location jsonb;
