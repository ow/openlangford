"""Permission regression checks, with synthetic data in disposable PostgreSQL."""
from pathlib import Path
from postgres_case import PostgresCase

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / 'supabase/migrations'
MIGRATION = MIGRATIONS / '20261022053745_47_19_public_write_boundaries.sql'
A = '00000000-0000-0000-0000-000000000001'
B = '00000000-0000-0000-0000-000000000002'


class PublicWriteBoundaries(PostgresCase):
    def setUp(self):
        self.sql("""
          DROP SCHEMA public CASCADE; CREATE SCHEMA public;
          DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA auth;
          DO $$ BEGIN
            IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
            IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
            IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
          END $$;
          GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
          CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
          CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.role',true) $$;
          CREATE TABLE municipalities(id bigint PRIMARY KEY);
          INSERT INTO municipalities VALUES(1);
          CREATE TABLE user_profiles(id uuid PRIMARY KEY,location_lng double precision,location_lat double precision);
        """)
        migration=(MIGRATIONS/'20260527155703_42_01_pipeline_ops_console.sql').read_text()
        self.sql(migration[migration.index('CREATE TABLE IF NOT EXISTS pipeline_jobs'):migration.index('DROP TRIGGER IF EXISTS set_timestamp_pipeline_jobs')])
        self.sql((MIGRATIONS/'20260218030321_create_search_results_cache.sql').read_text())
        for t in ['pipeline_jobs','user_profiles','search_results_cache']:
            self.sql(f'ALTER TABLE {t} ENABLE ROW LEVEL SECURITY; GRANT ALL ON {t} TO anon,authenticated,service_role;')
        self.sql('GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon,authenticated,service_role;')
        # Existing policies and RPC bodies are the pre-fix authority boundary.
        self.sql("""
          CREATE POLICY profile_read ON user_profiles FOR SELECT TO authenticated USING (auth.uid()=id);
          CREATE POLICY profile_update ON user_profiles FOR UPDATE TO authenticated USING (auth.uid()=id) WITH CHECK (auth.uid()=id);
          CREATE POLICY profile_insert ON user_profiles FOR INSERT TO authenticated WITH CHECK (auth.uid()=id);
          CREATE POLICY profile_service ON user_profiles FOR ALL USING (auth.role()='service_role') WITH CHECK (auth.role()='service_role');
          CREATE POLICY job_service ON pipeline_jobs FOR ALL USING (auth.role()='service_role') WITH CHECK (auth.role()='service_role');
        """)
        profile_migration=(MIGRATIONS/'20260527155704_43_01_auth_profiles_subscriptions.sql').read_text()
        self.sql(profile_migration[profile_migration.index('CREATE OR REPLACE FUNCTION update_user_location'):])
        self.sql((MIGRATIONS/'20260527155708_45_03_worker_job_type_and_source_lock.sql').read_text())
        self.sql("""
          GRANT EXECUTE ON FUNCTION update_user_location(uuid,double precision,double precision) TO PUBLIC,anon,authenticated,service_role;
          GRANT EXECUTE ON FUNCTION claim_next_pipeline_job(text,text[]) TO PUBLIC,anon,authenticated,service_role;
        """)
        self.sql(f"INSERT INTO user_profiles VALUES ('{A}',0,0),('{B}',0,0)")

    def apply_fix(self):
        for _ in range(2): self.sql(MIGRATION.read_text())

    def test_location_preserves_own_updates_and_blocks_cross_user_writes(self):
        # Live SECURITY DEFINER permissions allow an anonymous caller to mutate any known target ID.
        self.sql(f"SET ROLE anon; SELECT update_user_location('{B}',10,20)")
        self.assertEqual(self.sql(f"SELECT location_lng,location_lat FROM user_profiles WHERE id='{B}'")[0], '10|20')
        self.apply_fix()
        _,e=self.sql(f"SET ROLE anon; SELECT update_user_location('{B}',99,99)",success=False)
        self.assertIn('permission denied for function',e)
        auth=f"SET request.jwt.claim.sub='{A}'; SET request.jwt.claim.role='authenticated'; SET ROLE authenticated;"
        self.sql(auth+f"SELECT update_user_location('{A}',30,40); SELECT update_user_location('{B}',99,99)")
        self.assertEqual(self.sql(f"SELECT location_lng,location_lat FROM user_profiles WHERE id='{A}'")[0], '30|40')
        self.assertEqual(self.sql(f"SELECT location_lng,location_lat FROM user_profiles WHERE id='{B}'")[0], '10|20')
        self.sql(f"SET ROLE authenticated; SELECT update_user_location('{B}',99,99)")
        self.assertEqual(self.sql(f"SELECT location_lng FROM user_profiles WHERE id='{B}'")[0], '10')
        self.sql(f"SET ROLE service_role; SELECT update_user_location('{B}',50,60)")
        self.assertEqual(self.sql(f"SELECT location_lng,location_lat FROM user_profiles WHERE id='{B}'")[0], '50|60')

    def test_job_claim_is_service_only_with_job_filter_preserved(self):
        self.sql("INSERT INTO pipeline_jobs(municipality_id,job_type,args) VALUES (1,'fixture','{\"source_meeting_id\":1}')")
        self.sql("SET ROLE anon; SELECT id FROM claim_next_pipeline_job('untrusted',ARRAY['fixture'])")
        self.assertEqual(self.sql('SELECT status,locked_by FROM pipeline_jobs')[0],'running|untrusted')
        self.sql("TRUNCATE pipeline_jobs; INSERT INTO pipeline_jobs(municipality_id,job_type,args) VALUES(1,'fixture','{\"source_meeting_id\":2}')")
        self.apply_fix()
        for role in ['anon','authenticated']:
            _,e=self.sql(f"SET ROLE {role}; SELECT * FROM claim_next_pipeline_job('untrusted')",success=False)
            self.assertIn('permission denied for function',e)
        self.assertEqual(self.sql("SET ROLE service_role; SELECT count(*) FROM claim_next_pipeline_job('trusted',ARRAY['other'])")[0],'SET\n0')
        self.assertEqual(self.sql("SET ROLE service_role; SELECT status,locked_by,attempt_count,args->>'source_meeting_id' FROM claim_next_pipeline_job('trusted',ARRAY['fixture'])")[0],'SET\nrunning|trusted|1|2')

    def test_cache_blocks_poisoning_and_preserves_public_expiry_and_server_writes(self):
        self.sql("SET ROLE anon; INSERT INTO search_results_cache(id,query,answer) VALUES('fixture','Question','Forged answer')")
        self.assertEqual(self.sql('SELECT answer FROM search_results_cache')[0],'Forged answer')
        self.apply_fix()
        self.sql("INSERT INTO search_results_cache(id,query,answer,expires_at) VALUES('expired','Old','Expired',now()-interval '1 day')")
        for role in ['anon','authenticated']:
            self.assertEqual(self.sql(f'SET ROLE {role}; SELECT id FROM search_results_cache')[0],'SET\nfixture')
            for q in ["INSERT INTO search_results_cache(query,answer) VALUES('Bad','Bad')", "UPDATE search_results_cache SET answer='Bad'",'DELETE FROM search_results_cache','TRUNCATE search_results_cache']:
                _,e=self.sql(f'SET ROLE {role}; '+q,success=False)
                self.assertIn('permission denied',e)
        self.sql("SET ROLE service_role; INSERT INTO search_results_cache(id,query,answer) VALUES('server','Question','Reviewed answer'); UPDATE search_results_cache SET suggested_followups=ARRAY['Next?'] WHERE id='server'")
        self.assertEqual(self.sql("SELECT answer,suggested_followups[1] FROM search_results_cache WHERE id='server'")[0],'Reviewed answer|Next?')
