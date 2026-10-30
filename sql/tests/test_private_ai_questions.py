"""AI questions stay private: synthetic data in disposable PostgreSQL."""
from pathlib import Path
from postgres_case import PostgresCase

MIGRATIONS = Path(__file__).resolve().parents[2] / 'supabase/migrations'
FIX = MIGRATIONS / '20261030190000_private_ai_questions.sql'


class PrivateAiQuestions(PostgresCase):
    def setUp(self):
        self.sql("""
          DROP SCHEMA public CASCADE; CREATE SCHEMA public;
          DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA auth;
          CREATE TABLE auth.users(id uuid PRIMARY KEY);
          DO $$ BEGIN
            IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
            IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
            IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
          END $$;
          GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
        """)
        # Live state before the fix: the original tables plus the public read grant.
        for name in ['20260218030321_create_search_results_cache.sql',
                     '20261019074336_47_09_search_answer_cache.sql',
                     '20260306031054_37_01_rag_traces_and_feedback.sql']:
            self.sql((MIGRATIONS / name).read_text())
        self.sql('GRANT ALL ON ALL TABLES IN SCHEMA public TO anon,authenticated,service_role;')
        self.sql("""
          REVOKE ALL ON search_results_cache FROM anon,authenticated;
          GRANT SELECT ON search_results_cache TO anon,authenticated;
          INSERT INTO search_results_cache(id,query,answer,expires_at) VALUES
            ('live','Question','Answer',now()+interval '1 day'),('old','Old','Old',now()-interval '1 day');
          INSERT INTO rag_traces(id,query,client_ip,created_at) VALUES
            ('00000000-0000-0000-0000-00000000000a','Recent','192.0.2.1',now()-interval '2 days'),
            ('00000000-0000-0000-0000-00000000000b','Stale','192.0.2.2',now()-interval '40 days');
          INSERT INTO rag_feedback(trace_id,rating,client_ip) VALUES
            ('00000000-0000-0000-0000-00000000000a',1,'192.0.2.1'),('00000000-0000-0000-0000-00000000000b',-1,'192.0.2.2');
        """)

    def test_public_roles_lose_access_and_old_data_is_cleared(self):
        self.assertEqual(self.sql('SET ROLE anon; SELECT count(*) FROM search_results_cache')[0], 'SET\n1')
        for _ in range(2):
            self.sql(FIX.read_text())
        for role in ['anon', 'authenticated']:
            for q in ['SELECT id FROM search_results_cache', 'SELECT id FROM rag_traces',
                      "INSERT INTO rag_feedback(trace_id,rating) VALUES('00000000-0000-0000-0000-00000000000a',1)"]:
                _, e = self.sql(f'SET ROLE {role}; {q}', success=False)
                self.assertIn('permission denied', e)
        self.assertEqual(self.sql('SELECT string_agg(id,\',\') FROM search_results_cache')[0], 'live')
        self.assertEqual(self.sql('SELECT query FROM rag_traces')[0], 'Recent')
        self.assertEqual(self.sql('SELECT count(*) FROM rag_feedback')[0], '1')
        self.assertEqual(self.sql('SELECT count(client_ip) FROM rag_traces')[0], '0')
        self.assertEqual(self.sql('SELECT count(client_ip) FROM rag_feedback')[0], '0')
        # The server keeps full access.
        self.sql("SET ROLE service_role; INSERT INTO search_results_cache(id,query,answer) VALUES('server','Q','A');"
                 "UPDATE search_results_cache SET suggested_followups=ARRAY['Next?'] WHERE id='server';"
                 "SELECT id FROM search_results_cache WHERE id='server'; DELETE FROM search_results_cache WHERE id='server'")
