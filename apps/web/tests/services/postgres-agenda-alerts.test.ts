import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Before-meeting agenda alerts (supabase/migrations/20261108200000_agenda_alerts.sql), on the real baseline schema,
// in an explicitly created disposable local container, never production. The image needs pgvector:
//   docker run -d --rm --name langford-pg -e POSTGRES_PASSWORD=pw public.ecr.aws/supabase/postgres:17.11.0.011
//   LANGFORD_TEST_PG_CONTAINER=langford-pg npx vitest run tests/services/postgres-agenda-alerts.test.ts
const container = process.env.LANGFORD_TEST_PG_CONTAINER;
const DB = "langford_agenda_alerts_test";
const command = (statement: string, database = DB) => {
  const directory = mkdtempSync(join(tmpdir(), "langford-sql-"));
  const file = join(directory, "query.sql");
  const remote = `/tmp/${basename(directory)}.sql`;
  const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
  try {
    writeFileSync(file, statement);
    docker(["cp", file, `${container}:${remote}`]);
    return docker(["exec", container!, "psql", "-U", "postgres", "-d", database, "-Atq", "-v", "ON_ERROR_STOP=1", "-f", remote]).trim();
  } finally {
    try { docker(["exec", container!, "rm", "-f", remote]); } finally { rmSync(directory, { recursive: true, force: true }); }
  }
};
const sql = (statement: string) => command(statement);
const json = (statement: string) => JSON.parse(sql(statement) || "null");
const root = new URL("../../../../supabase/migrations/", import.meta.url);
const files = readdirSync(root).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
const AGENDA = "20261108200000_agenda_alerts.sql";
const migration = (name: string) => readFileSync(new URL(name, root), "utf8");

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const U = {
  topic: uid(1), topicOff: uid(2), everyMeeting: uid(3), keyword: uid(4), neighbourhood: uid(5), nearby: uid(6),
  person: uid(7), matter: uid(8), inactive: uid(9), legacy: uid(10), suppressed: uid(11), unconfirmed: uid(12), noMatch: uid(13),
};
// Uniform vector vs a one-hot vector: cosine similarity 1.0 with itself, about 0.05 with the other.
const vec = (kind: "uniform" | "onehot") =>
  `'[${Array.from({ length: 384 }, (_, i) => (kind === "uniform" ? "0.1" : i === 0 ? "1" : "0")).join(",")}]'::halfvec`;

/** Meetings and people chosen so every matching rule, profile rule and meeting state is exercised. */
function seed() {
  const users = Object.entries(U).map(([name, id]) => {
    const confirmed = name === "unconfirmed" ? "NULL" : "now()";
    return `INSERT INTO auth.users(id,email,email_confirmed_at) VALUES('${id}','${name}@example.test',${confirmed});
      INSERT INTO user_profiles(id,email_alerts_enabled,email_alerts_consent_at,email_alerts_consent_version,digest_frequency,digest_enabled,onboarding_completed,location_lat,location_lng,location_label)
      VALUES('${id}',true,${name === "legacy" ? "NULL" : "'2026-10-01'"},'${name === "legacy" ? "legacy-digest-v1" : "per-meeting-v1"}','each_meeting',
        ${name === "everyMeeting" || name === "legacy"},${name === "legacy"},${name === "nearby" ? "48.45,-123.5,'Walfred Road'" : "NULL,NULL,NULL"});`;
  }).join("\n");
  return `
    INSERT INTO municipalities(id,slug,name,short_name) VALUES(1,'langford','City of Langford','Langford'),(2,'elsewhere','Elsewhere','Elsewhere');
    INSERT INTO topics(id,name) VALUES(1,'Housing'),(2,'Finance');
    INSERT INTO matters(id,title,slug,category) VALUES(1,'Walfred Road homes','walfred-road-homes','Housing'),(2,'Budget','budget','Finance');
    INSERT INTO people(id,name,slug) VALUES(99,'A Member','a-member');
    INSERT INTO meetings(id,title,meeting_date,type,status,has_agenda,has_minutes,has_transcript,slug,municipality_id,meta) VALUES
      (1,'Regular Council',current_date-3,'Regular Council','Completed',true,true,false,'past-council',1,NULL),
      (2,'Regular Council',current_date+7,'Regular Council','Planned',true,false,false,'future-council',1,'{"calendar":{"start_time":"19:00"}}'),
      (3,'Regular Council',current_date+8,'Regular Council','Cancelled',true,false,false,'cancelled-council',1,NULL),
      (4,'Regular Council',current_date+9,'Regular Council','Planned',false,false,false,'no-agenda-council',1,NULL),
      (5,'Regular Council',current_date+7,'Regular Council','Planned',true,false,false,'elsewhere-council',2,NULL),
      (6,'Regular Council',current_date-10,'Regular Council','Planned',true,false,false,'past-agenda-only',1,NULL);
    INSERT INTO agenda_items(id,meeting_id,matter_id,parent_id,item_order,title,plain_english_summary,category,neighborhood,geo_location,embedding,slug) VALUES
      (10,1,1,NULL,'1','Rezone 953 Walfred Road','Council considered 47 homes.','Land Use','Westhills','{"lat":48.4501,"lng":-123.5001}',${vec("uniform")},'i10'),
      (11,1,NULL,NULL,'2','CALL TO ORDER',NULL,'Procedural',NULL,NULL,${vec("onehot")},'i11'),
      (20,2,NULL,NULL,'1','CALL TO ORDER','The meeting starts.','Procedural',NULL,NULL,${vec("uniform")},'i20'),
      (21,2,1,NULL,'8.1','Application to Rezone 953 Walfred Road','A proposal for 47 homes on Walfred Road.','Housing','Westhills','{"lat":48.4501,"lng":-123.5001}',${vec("onehot")},'i21'),
      (22,2,NULL,NULL,'9','PUBLIC HEARINGS',NULL,'Land Use',NULL,NULL,${vec("onehot")},'i22'),
      (23,2,NULL,22,'9.1','BYLAW NO. 9 (Station Avenue)','Rules for 30 homes on Station Avenue.','Land Use',NULL,NULL,${vec("uniform")},'i23'),
      (24,2,NULL,NULL,'10','Parks budget',NULL,'Parks',NULL,NULL,${vec("onehot")},'i24'),
      (30,3,1,NULL,'1','Cancelled rezoning',NULL,'Housing',NULL,NULL,${vec("onehot")},'i30'),
      (40,4,1,NULL,'1','No agenda rezoning',NULL,'Housing',NULL,NULL,${vec("onehot")},'i40'),
      (50,5,1,NULL,'1','Elsewhere rezoning',NULL,'Housing',NULL,NULL,${vec("onehot")},'i50'),
      (60,6,1,NULL,'1','Old rezoning',NULL,'Housing',NULL,NULL,${vec("onehot")},'i60');
    INSERT INTO motions(id,meeting_id,agenda_item_id,mover_id,text_content,slug) VALUES(1,1,10,99,'That council approve.','m1');
    ${users}
    INSERT INTO subscriptions(user_id,type,topic_id,is_active) VALUES('${U.topic}','topic',1,true),('${U.topicOff}','topic',1,true),('${U.inactive}','topic',1,false),('${U.noMatch}','topic',2,true);
    INSERT INTO subscriptions(user_id,type,keyword,keyword_embedding,is_active) VALUES('${U.keyword}','topic','station avenue homes',${vec("uniform")},true);
    INSERT INTO subscriptions(user_id,type,neighborhood,is_active) VALUES('${U.neighbourhood}','neighborhood','Westhills',true);
    INSERT INTO subscriptions(user_id,type,proximity_radius_m,is_active) VALUES('${U.nearby}','neighborhood',500,true);
    INSERT INTO subscriptions(user_id,type,person_id,is_active) VALUES('${U.person}','person',99,true);
    INSERT INTO subscriptions(user_id,type,matter_id,is_active) VALUES('${U.matter}','matter',1,true);
    INSERT INTO subscriptions(user_id,type,topic_id,is_active) VALUES('${U.suppressed}','topic',1,true),('${U.unconfirmed}','topic',1,true);
    INSERT INTO email_suppressions(recipient,user_id,reason) VALUES('suppressed@example.test','${U.suppressed}','unsubscribe');
  `;
}

/** find_meeting_subscribers for every meeting, under several preference states, as one comparable value. */
const SNAPSHOT = `
  CREATE TEMP TABLE snap(state text, meeting bigint, user_id uuid, email text, consent timestamptz);
  INSERT INTO snap SELECT 'seeded', m.id, f.* FROM meetings m, find_meeting_subscribers(m.id) f;
  UPDATE user_profiles SET digest_enabled=false;
  INSERT INTO snap SELECT 'no-digests', m.id, f.* FROM meetings m, find_meeting_subscribers(m.id) f;
  UPDATE subscriptions SET is_active=NOT is_active;
  INSERT INTO snap SELECT 'flipped', m.id, f.* FROM meetings m, find_meeting_subscribers(m.id) f;
  UPDATE agenda_items SET embedding=NULL, neighborhood=NULL;
  INSERT INTO snap SELECT 'no-embeddings', m.id, f.* FROM meetings m, find_meeting_subscribers(m.id) f;
  SELECT jsonb_agg(to_jsonb(s) ORDER BY state, meeting, user_id)::text FROM snap s;`;
const snapshot = () => sql(`BEGIN; ${SNAPSHOT} ROLLBACK;`);

const enqueue = (meeting: number, test: string | null = null) =>
  Number(sql(`SELECT enqueue_agenda_alert_emails(${meeting}, current_date - 30, ${test ? `'${test}'` : "NULL"});`));
const messages = () =>
  json(`SELECT coalesce(json_agg(json_build_object('user',user_id,'key',deduplication_key,'type',message_type,'subject',subject,'payload',payload,'test',is_test) ORDER BY deduplication_key),'[]') FROM email_messages;`) as any[];
const keysFor = (user: string) => messages().filter((m) => m.user === user).map((m) => m.key);

describe.skipIf(!container)("before-meeting agenda alerts", { timeout: 60_000 }, () => {
  let before = "";
  beforeAll(() => {
    command(`DROP DATABASE IF EXISTS ${DB}; CREATE DATABASE ${DB};`, "postgres");
    command("DO $roles$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END $roles$;", "postgres");
    // The parts of Supabase's auth schema the baseline refers to.
    sql(`CREATE SCHEMA IF NOT EXISTS auth; CREATE SCHEMA IF NOT EXISTS extensions;
      CREATE TABLE auth.users(id uuid PRIMARY KEY, email text, email_confirmed_at timestamptz, created_at timestamptz DEFAULT now(), last_sign_in_at timestamptz, raw_user_meta_data jsonb, raw_app_meta_data jsonb);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.role', true), '') $$;
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;`);
    for (const file of files.filter((f) => f < AGENDA)) sql(`BEGIN;\n${migration(file)}\nCOMMIT;`);
    sql(seed());
    before = snapshot();
    sql(`BEGIN;\n${migration(AGENDA)}\nCOMMIT;`);
    // Existing profiles get the new column's default (on); one person turns it off.
    sql(`UPDATE user_profiles SET agenda_alerts_enabled=false WHERE id='${U.topicOff}';`);
  });

  it("leaves find_meeting_subscribers' results unchanged, now through the shared matching function", () => {
    expect(before.length).toBeGreaterThan(100);
    expect(snapshot()).toBe(before);
    const parsed = JSON.parse(before) as any[];
    const seeded = (meeting: number) => parsed.filter((r) => r.state === "seeded" && r.meeting === meeting).map((r) => r.user_id).sort();
    // Every rule is exercised: topic, keyword, neighbourhood, nearby, person (motions), matter, every-meeting and legacy digests.
    expect(seeded(1)).toEqual([U.topic, U.topicOff, U.everyMeeting, U.keyword, U.neighbourhood, U.nearby, U.person, U.matter, U.legacy].sort());
    expect(sql("SELECT prosrc LIKE '%alert_subscription_matches%' FROM pg_proc WHERE proname='find_meeting_subscribers';")).toBe("t");
  });

  it("queues one preview per subscriber with the toggle on, listing only their matched items", () => {
    sql("DELETE FROM email_messages;");
    expect(enqueue(2)).toBeGreaterThan(0);
    const all = messages();
    expect(all.every((m) => m.type === "agenda_preview" && !m.test)).toBe(true);
    expect(keysFor(U.topic)).toEqual([`agenda/2/user/${U.topic}/live`]);
    expect(keysFor(U.topicOff)).toEqual([]);
    expect(keysFor(U.noMatch)).toEqual([]); // follows Finance: nothing on this agenda
    const topic = all.find((m) => m.user === U.topic);
    expect(topic.subject).toMatch(/^Coming up at council: Regular Council, [A-Z][a-z]+ \d{1,2}$/);
    expect(topic.payload.meeting).toMatchObject({ id: 2, slug: "future-council", start_time: "19:00" });
    expect(topic.payload.items).toEqual([
      { id: 21, title: "Application to Rezone 953 Walfred Road", summary: "A proposal for 47 homes on Walfred Road.", category: "Housing", public_hearing: false, reasons: [{ type: "topic", label: "Housing" }] },
    ]);
    expect(topic.payload.item_ids).toEqual([21]);
    expect(topic.payload.updated).toBe(false);
    // Keyword matched only the hearing item; it is flagged as a public hearing through its section heading.
    const keyword = all.find((m) => m.user === U.keyword);
    expect(keyword.payload.items.map((i: any) => [i.id, i.public_hearing, i.reasons])).toEqual([[23, true, [{ type: "keyword", label: "station avenue homes" }]]]);
    // Every-meeting subscribers get all substantive items, without procedural ones; matched ones carry a reason.
    const every = all.find((m) => m.user === U.everyMeeting);
    expect(every.payload.item_ids).toEqual([21, 22, 23, 24]);
    expect(every.payload.items.every((i: any) => i.reasons.length === 0)).toBe(true);
    // Nearby and neighbourhood say which place matched; the person rule (motions) never matches an agenda.
    expect(all.find((m) => m.user === U.nearby).payload.items[0].reasons).toEqual([{ type: "nearby", label: "Walfred Road" }]);
    expect(all.find((m) => m.user === U.neighbourhood).payload.items[0].reasons).toEqual([{ type: "neighborhood", label: "Westhills" }]);
    expect(keysFor(U.person)).toEqual([]);
    for (const user of [U.inactive, U.suppressed, U.unconfirmed]) expect(keysFor(user)).toEqual([]);
  });

  it("sends nothing for past, cancelled, agenda-less or other-municipality meetings", () => {
    sql("DELETE FROM email_messages;");
    for (const meeting of [1, 3, 4, 5, 6]) expect(enqueue(meeting)).toBe(0);
    // Before the live start date, too.
    expect(Number(sql("SELECT enqueue_agenda_alert_emails(2, current_date + 8, NULL);"))).toBe(0);
    expect(Number(sql("SELECT enqueue_agenda_alert_emails(2, NULL, NULL);"))).toBe(0);
    expect(messages()).toEqual([]);
  });

  it("sends nothing when nothing on the agenda matches", () => {
    sql("DELETE FROM email_messages;");
    sql(`UPDATE user_profiles SET agenda_alerts_enabled=false WHERE id<>'${U.noMatch}';`);
    try {
      expect(enqueue(2)).toBe(0);
      // The same person once the agenda has a Finance item.
      sql("UPDATE agenda_items SET category='Finance' WHERE id=24;");
      expect(enqueue(2)).toBe(1);
    } finally {
      sql(`UPDATE agenda_items SET category='Parks' WHERE id=24; UPDATE user_profiles SET agenda_alerts_enabled=(id<>'${U.topicOff}'); DELETE FROM email_messages;`);
    }
  });

  it("dedups repeat calls, and sends one update when a new matching item appears", () => {
    sql("DELETE FROM email_messages;");
    const first = enqueue(2);
    expect(first).toBeGreaterThan(0);
    expect(enqueue(2)).toBe(0);
    sql(`INSERT INTO agenda_items(id,meeting_id,item_order,title,plain_english_summary,category,embedding,slug)
      VALUES(25,2,'8.2','Rezone 100 Goldstream Avenue','Six homes on Goldstream Avenue.','Housing',${vec("onehot")},'i25');`);
    enqueue(2);
    expect(keysFor(U.topic)).toEqual([`agenda/2/user/${U.topic}`, `agenda/2/user/${U.topic}/update`].map((k) => `${k}/live`).sort());
    const update = messages().find((m) => m.key === `agenda/2/user/${U.topic}/update/live`);
    expect(update.payload.updated).toBe(true);
    expect(update.payload.item_ids).toEqual([21, 25]);
    // Users whose matches didn't change get nothing new; a further change is not sent again.
    expect(keysFor(U.keyword)).toHaveLength(1);
    sql(`INSERT INTO agenda_items(id,meeting_id,item_order,title,category,embedding,slug) VALUES(26,2,'8.3','Rezone 5 Main Street','Housing',${vec("onehot")},'i26');`);
    expect(enqueue(2)).toBe(0);
    sql("DELETE FROM agenda_items WHERE id IN (25,26); DELETE FROM email_messages;");
  });

  it("waits for embeddings, and a test recipient gets only their own test preview", () => {
    sql("DELETE FROM email_messages; UPDATE agenda_items SET embedding=NULL WHERE id=21;");
    expect(() => enqueue(2)).toThrow(/not ready/);
    sql(`UPDATE agenda_items SET embedding=${vec("onehot")} WHERE id=21;`);
    expect(enqueue(2, "Topic@example.test")).toBe(1);
    const [only] = messages();
    expect(only).toMatchObject({ user: U.topic, key: `agenda/2/user/${U.topic}/test`, test: true });
    expect(only.subject).toMatch(/^\[Test\] Coming up at council/);
    sql("DELETE FROM email_messages;");
  });

  it("checks eligibility at delivery: upcoming meeting and toggle for previews, minutes for digests", () => {
    sql("DELETE FROM email_messages;");
    enqueue(2);
    sql("SELECT enqueue_meeting_emails(1, current_date - 30, NULL); UPDATE email_messages SET status='attempting';");
    const eligible = (user: string, type: string) =>
      sql(`SELECT email_alert_eligible(id, current_date - 30) FROM email_messages WHERE user_id='${user}' AND message_type='${type}';`);
    expect(eligible(U.topic, "agenda_preview")).toBe("t");
    expect(eligible(U.topic, "meeting_digest")).toBe("t");
    sql(`UPDATE user_profiles SET agenda_alerts_enabled=false WHERE id='${U.topic}';`);
    expect(eligible(U.topic, "agenda_preview")).toBe("f");
    expect(eligible(U.topic, "meeting_digest")).toBe("t"); // the toggle only affects before-meeting emails
    sql(`UPDATE user_profiles SET agenda_alerts_enabled=true WHERE id='${U.topic}'; UPDATE meetings SET status='Cancelled' WHERE id=2;`);
    expect(eligible(U.topic, "agenda_preview")).toBe("f");
    sql("UPDATE meetings SET status='Planned', meeting_date=current_date-1 WHERE id=2;");
    expect(eligible(U.topic, "agenda_preview")).toBe("f");
    sql("UPDATE meetings SET meeting_date=current_date+7 WHERE id=2; DELETE FROM email_messages;");
  });

  it("is callable by the server key only", () => {
    for (const fn of ["enqueue_agenda_alert_emails(2, current_date, NULL)", `build_agenda_preview(2, '${U.topic}')`, "alert_subscription_matches(2)"]) {
      expect(() => sql(`SET ROLE anon; SELECT ${fn};`)).toThrow(/permission denied/);
      expect(() => sql(`SET ROLE authenticated; SELECT ${fn};`)).toThrow(/permission denied/);
    }
    expect(sql(`SET ROLE service_role; SELECT jsonb_array_length(build_agenda_preview(2, '${U.topic}')->'items');`)).toBe("1");
  });
});
