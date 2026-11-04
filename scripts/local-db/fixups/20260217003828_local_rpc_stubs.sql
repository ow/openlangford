-- LOCAL ONLY. 20260217003829_fix_rpc_search_path alters three subscription functions that production
-- already had from an earlier, pre-migration schema (PR #13). bootstrap.sql has none of
-- them, so create placeholders with the same signatures (find_meeting_subscribers with the return type
-- 20260217042401 replaces it with). build_meeting_digest is
-- replaced by 20261025081711_47_21; find_matters_near is dropped again by post/parity.sql (production
-- no longer has it).
CREATE OR REPLACE FUNCTION public.find_matters_near(double precision, double precision, integer, integer)
RETURNS void LANGUAGE sql AS $$ SELECT $$;
DO $$ BEGIN
  IF to_regprocedure('public.build_meeting_digest(bigint)') IS NULL THEN
    CREATE FUNCTION public.build_meeting_digest(bigint) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
  END IF;
  IF to_regprocedure('public.find_meeting_subscribers(bigint)') IS NULL THEN
    CREATE FUNCTION public.find_meeting_subscribers(target_meeting_id bigint)
    RETURNS TABLE (user_id uuid, subscription_id bigint, subscription_type subscription_type, notification_email text)
    LANGUAGE sql AS 'SELECT NULL::uuid, NULL::bigint, NULL::subscription_type, NULL::text WHERE false';
  END IF;
END $$;
