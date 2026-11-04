-- LOCAL ONLY. 20260313051431_39_key_votes_table attaches a trigger to update_updated_at_column(), which
-- production resolved from its Storage schema; the local stack runs without Storage. Provide a shim; the
-- trigger and shim are removed by post/parity.sql because production no longer has that trigger.
CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
