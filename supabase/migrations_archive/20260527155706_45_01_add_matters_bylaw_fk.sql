ALTER TABLE matters ADD COLUMN IF NOT EXISTS bylaw_id bigint;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'matters_bylaw_id_fkey'
    ) THEN
        ALTER TABLE matters
            ADD CONSTRAINT matters_bylaw_id_fkey
            FOREIGN KEY (bylaw_id) REFERENCES bylaws(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_matters_bylaw_id ON matters(bylaw_id);
