-- The heavy search and statistics functions are called only by the site's server with the service role, but the
-- publishable key could call them too (and someone has been bulk-reading through it), each call costing seconds on
-- a small database. Take EXECUTE away from the public roles on every version of them. Functions the site calls as a
-- signed-in resident (set_email_alert_consent) and ones triggers rely on (matter_root) are untouched.

DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname = ANY (ARRAY[
       'get_meetings_with_stats', 'get_speaking_time_by_meeting', 'get_speaking_time_by_topic', 'get_speaking_time_stats',
       'get_unclassified_agenda_items', 'get_vote_stats_for_person',
       'hybrid_search_bylaw_chunks', 'hybrid_search_document_sections', 'hybrid_search_key_statements', 'hybrid_search_motions',
       'match_agenda_items', 'match_bylaw_chunks', 'match_bylaws', 'match_document_sections', 'match_key_statements',
       'match_key_statements_by_person', 'match_matters', 'match_motions', 'match_motions_by_person', 'match_review_examples'])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
