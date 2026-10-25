-- Minimal current-schema fixture, for an isolated PostgreSQL runtime only.
CREATE EXTENSION vector;
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
GRANT USAGE ON SCHEMA auth TO authenticated;
CREATE TABLE municipalities(id bigint PRIMARY KEY,slug text);
CREATE TABLE meetings(id bigint PRIMARY KEY,municipality_id bigint,title text,slug text,meeting_date date,has_minutes boolean,has_transcript boolean,summary text);
CREATE TABLE matters(id bigint PRIMARY KEY,category text);
CREATE TABLE topics(id bigint PRIMARY KEY,name text);
CREATE TABLE agenda_items(id bigint PRIMARY KEY,meeting_id bigint,matter_id bigint,title text,category text,neighborhood text,geo_location jsonb,embedding halfvec(384));
CREATE TABLE motions(id bigint PRIMARY KEY,meeting_id bigint,agenda_item_id bigint,plain_english_summary text,text_content text,result text,yes_votes int,no_votes int,mover_id bigint,seconder_id bigint);
CREATE TABLE user_profiles(id uuid PRIMARY KEY REFERENCES auth.users(id),notification_email text,onboarding_completed boolean DEFAULT false,digest_enabled boolean DEFAULT false,digest_frequency text DEFAULT 'each_meeting',location_lat double precision,location_lng double precision);
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
GRANT SELECT,UPDATE ON user_profiles TO authenticated;
CREATE POLICY own_profile ON user_profiles TO authenticated USING(id=auth.uid()) WITH CHECK(id=auth.uid());
CREATE TABLE subscriptions(id bigint PRIMARY KEY,user_id uuid,type text,is_active boolean,matter_id bigint,topic_id bigint,person_id bigint,neighborhood text,proximity_radius_m int DEFAULT 1000,keyword_embedding halfvec(384));
INSERT INTO municipalities VALUES(1,'langford'),(2,'other-city');
INSERT INTO meetings VALUES(1,1,'Council test','council-test',current_date,true,false,'Council approved a park plan.'),(2,1,'Historical meeting','historical',current_date-30,true,false,'Old meeting'),(3,1,'Agenda only','agenda-only',current_date,false,false,'No decisions yet'),(4,2,'Other city','other-city',current_date,true,false,'Other records');
INSERT INTO matters VALUES(1,'Transportation'); INSERT INTO topics VALUES(1,'Transportation');
INSERT INTO agenda_items VALUES(1,1,1,'Park plan','Transportation','Downtown','{"lat":48.45,"lng":-123.5}',null);
INSERT INTO motions VALUES(1,1,1,'Approve a park plan','Approve plan','CARRIED',6,1,99,null);
INSERT INTO auth.users VALUES('11111111-1111-4111-8111-111111111111','reader@example.test',now()),('22222222-2222-4222-8222-222222222222','pending@example.test',null);
INSERT INTO user_profiles(id,notification_email,digest_enabled,location_lat,location_lng) VALUES('11111111-1111-4111-8111-111111111111','reader@example.test',true,48.45,-123.5),('22222222-2222-4222-8222-222222222222',null,true,null,null);

UPDATE agenda_items SET embedding=(ARRAY[1::real] || array_fill(0::real, ARRAY[383]))::halfvec;

ALTER TABLE agenda_items ADD COLUMN plain_english_summary text;
ALTER TABLE agenda_items ADD COLUMN debate_summary text;
ALTER TABLE agenda_items ADD COLUMN discussion_start_time double precision;
ALTER TABLE agenda_items ADD COLUMN discussion_end_time double precision;
CREATE TABLE transcript_segments(id bigint PRIMARY KEY,meeting_id bigint,agenda_item_id bigint,start_time double precision,speaker_name text,text_content text);
