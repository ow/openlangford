"""A motion or a hand-set stage on an entry moves its topics' freshness stamp: synthetic data in disposable PostgreSQL."""
from pathlib import Path
from postgres_case import PostgresCase

FIX = Path(__file__).resolve().parents[2] / 'supabase/migrations/20261109000000_motion_and_stage_freshness.sql'


class MotionStageFreshness(PostgresCase):
    def setUp(self):
        self.sql("""
          DROP SCHEMA public CASCADE; CREATE SCHEMA public;
          DO $$ BEGIN
            IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
            IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
          END $$;
          GRANT USAGE ON SCHEMA public TO anon, authenticated;
          CREATE TABLE matters(id bigint PRIMARY KEY, content_updated_at timestamptz);
          CREATE TABLE agenda_items(id bigint PRIMARY KEY, matter_id bigint, meta jsonb DEFAULT '{}');
          CREATE TABLE matter_links(id bigint PRIMARY KEY, matter_id bigint, agenda_item_id bigint, hidden boolean DEFAULT false);
          CREATE TABLE motions(id bigint PRIMARY KEY, agenda_item_id bigint, text_content text, plain_english_summary text,
                               result text, disposition text, mover text);
          INSERT INTO matters VALUES (1,'2020-01-01'),(2,'2020-01-01'),(3,'2020-01-01'),(4,'2020-01-01');
          INSERT INTO agenda_items(id, matter_id) VALUES (10,1),(20,4);
          INSERT INTO matter_links VALUES (1,2,10,false),(2,3,10,true);
        """)
        for _ in range(2):
            self.sql(FIX.read_text())

    def stamps(self):
        return self.sql("SELECT string_agg(id || '=' || (content_updated_at > '2020-01-02'), ',' ORDER BY id) FROM matters")[0]

    def reset(self):
        self.sql("UPDATE matters SET content_updated_at = '2020-01-01'")

    def test_adding_a_motion_stamps_its_topic_and_shown_mentions(self):
        self.sql("INSERT INTO motions VALUES (1,10,'That Council adopt Bylaw No. 1239.',null,'CARRIED','Substantive',null)")
        self.assertEqual(self.stamps(), '1=true,2=true,3=false,4=false')

    def test_only_visible_motion_changes_count(self):
        self.sql("INSERT INTO motions VALUES (1,10,'That Council adopt Bylaw No. 1239.',null,'CARRIED','Substantive',null)")
        self.reset()
        self.sql("UPDATE motions SET mover = 'Roger Wade'")
        self.assertEqual(self.stamps(), '1=false,2=false,3=false,4=false')
        self.sql("UPDATE motions SET agenda_item_id = 20")
        self.assertEqual(self.stamps(), '1=true,2=true,3=false,4=true')
        self.reset()
        self.sql("DELETE FROM motions")
        self.assertEqual(self.stamps(), '1=false,2=false,3=false,4=true')

    def test_a_hand_set_stage_stamps_but_other_meta_does_not(self):
        self.sql("""UPDATE agenda_items SET meta = '{"participation": 1}' WHERE id = 10""")
        self.assertEqual(self.stamps(), '1=false,2=false,3=false,4=false')
        self.sql("""UPDATE agenda_items SET meta = meta || '{"staff_stage": {"stage": "first"}}' WHERE id = 10""")
        self.assertEqual(self.stamps(), '1=true,2=true,3=false,4=false')

    def test_public_roles_cannot_call_the_functions(self):
        _, e = self.sql("SET ROLE anon; SELECT bump_matter_content_for_items(ARRAY[10::bigint])", success=False)
        self.assertIn('permission denied', e)
