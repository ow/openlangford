import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const migration = (name: string) => readFileSync(new URL(`../../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

const reader = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
let db: PGlite;

beforeAll(async () => {
  db = new PGlite({ extensions: { vector } });
  await db.exec(fixture("email-schema.sql"));
  for (const name of [
    "20261025052302_47_20_application_email_ledger.sql",
    "20261025081711_47_21_per_meeting_email_alerts.sql",
    "20260220235430_create_api_keys.sql",
    "20261020022127_contact_messages.sql",
    "20261029190000_contact_messages_handling.sql",
  ]) await db.exec(migration(name));
  await db.exec(`
    CREATE TABLE rag_traces(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES auth.users, created_at timestamptz DEFAULT now());
    CREATE TABLE rag_feedback(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES auth.users);
    ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_user FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  `);
  await db.exec(migration("20261030200000_account_deletion.sql"));
  await db.exec(migration("20261030201000_privacy_retention.sql"));
}, 30000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec("BEGIN");
  await db.exec(`
    INSERT INTO subscriptions(id,user_id,type,is_active) VALUES (1,'${reader}','topic',true),(2,'${other}','topic',true);
    INSERT INTO api_keys(user_id,key_hash,key_prefix) VALUES ('${reader}','hash','abcd1234'),('${other}','hash2','efgh5678');
    INSERT INTO email_messages(id,user_id,recipient,subject,message_type,status,deduplication_key,preview_text,payload,provider_payload,delivered_at)
      VALUES ('aaaaaaaa-0000-4000-8000-000000000001','${reader}','reader@example.test','Council update','meeting_digest','delivered','meeting/1/user/${reader}/live','Near your home','{"near":"x"}','{"to":"reader@example.test"}',now()),
             ('aaaaaaaa-0000-4000-8000-000000000002',NULL,'reader@example.test','Council update','meeting_digest','queued','meeting/2/user/gone/live',NULL,'{}',NULL,NULL),
             ('aaaaaaaa-0000-4000-8000-000000000003','${other}','pending@example.test','Council update','meeting_digest','delivered','meeting/1/user/${other}/live','Hi','{}',NULL,now());
    INSERT INTO email_events(message_id,event_type,error_text) VALUES ('aaaaaaaa-0000-4000-8000-000000000001','delivered','bounced reader@example.test');
    INSERT INTO email_suppressions(recipient,user_id,reason) VALUES ('reader@example.test','${reader}','unsubscribe'),('old@example.test','${reader}','bounced');
    INSERT INTO rag_traces(user_id) VALUES ('${reader}');
    INSERT INTO rag_feedback(user_id) VALUES ('${reader}');
    INSERT INTO contact_messages(email,message,handled_at,handled_by) VALUES ('someone@example.test','hello',now(),'${reader}');
  `);
});
afterEach(async () => {
  await db.exec("ROLLBACK");
});

const rows = async <T = any>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

it("deletes the account's personal rows, anonymizes its email log, and lets the auth user be deleted", async () => {
  const [{ summary }] = await rows<{ summary: any }>("SELECT delete_account_data($1) summary", [reader]);
  expect(summary).toEqual({ emails_anonymized: 2, suppressions_deleted: 1, subscriptions_deleted: 1, api_keys_deleted: 1, profiles_deleted: 1 });

  expect(await rows("SELECT id FROM user_profiles WHERE id=$1", [reader])).toEqual([]);
  expect(await rows("SELECT id FROM subscriptions WHERE user_id=$1", [reader])).toEqual([]);
  expect(await rows("SELECT id FROM api_keys WHERE user_id=$1", [reader])).toEqual([]);

  const mail = await rows("SELECT recipient,user_id,status,delivered_at IS NOT NULL delivered,preview_text,payload,provider_payload,deduplication_key FROM email_messages WHERE id::text LIKE 'aaaaaaaa-0000-4000-8000-00000000000_' ORDER BY id");
  expect(mail[0]).toMatchObject({ recipient: "removed", user_id: null, status: "delivered", delivered: true, preview_text: null, payload: {}, provider_payload: null });
  expect(mail[0].deduplication_key).not.toContain(reader);
  // Unsent mail to the address is cancelled; another person's log is untouched.
  expect(mail[1]).toMatchObject({ recipient: "removed", status: "suppressed" });
  expect(mail[2]).toMatchObject({ recipient: "pending@example.test", user_id: other });
  expect(JSON.stringify(await rows("SELECT * FROM email_events"))).not.toContain("reader@example.test");

  // Bounces stay on the do-not-send list without the account link; the unsubscribe record goes.
  expect(await rows("SELECT recipient,user_id,reason FROM email_suppressions")).toEqual([{ recipient: "old@example.test", user_id: null, reason: "bounced" }]);
  expect(await rows("SELECT handled_by FROM contact_messages")).toEqual([{ handled_by: null }]);

  // Nothing references the account any more, so deleting the sign-in succeeds.
  await db.query("DELETE FROM auth.users WHERE id=$1", [reader]);
  expect(await rows("SELECT id FROM subscriptions WHERE user_id=$1", [other])).toHaveLength(1);
});

it("is safe to run twice (a retry after the sign-in deletion failed)", async () => {
  await db.query("SELECT delete_account_data($1)", [reader]);
  const [{ summary }] = await rows<{ summary: any }>("SELECT delete_account_data($1) summary", [reader]);
  expect(summary).toEqual({ emails_anonymized: 0, suppressions_deleted: 0, subscriptions_deleted: 0, api_keys_deleted: 0, profiles_deleted: 0 });
});

it("can't be called by visitors or signed-in accounts", async () => {
  for (const role of ["anon", "authenticated"]) {
    for (const call of [`SELECT delete_account_data('${reader}')`, "SELECT anonymize_email_messages('{}')"]) {
      await db.exec("SAVEPOINT r");
      await db.exec(`SET LOCAL ROLE ${role}`);
      await expect(db.query(call)).rejects.toThrow(/permission denied/);
      await db.exec("ROLLBACK TO r");
    }
  }
});

describe("12-month retention", () => {
  beforeEach(async () => {
    await db.exec(`
      UPDATE email_messages SET created_at = now() - interval '13 months' WHERE id = 'aaaaaaaa-0000-4000-8000-000000000003';
      INSERT INTO contact_messages(email,message,client_ip,created_at) VALUES ('old@example.test','old','203.0.113.1',now() - interval '13 months');
    `);
  });

  it("counts without changing anything on a dry run", async () => {
    const [{ summary }] = await rows<{ summary: any }>("SELECT apply_privacy_retention(true) summary");
    expect(summary).toEqual({ dry_run: true, contact_messages_deleted: 1, email_messages_anonymized: 1 });
    expect(await rows("SELECT count(*)::int n FROM contact_messages")).toEqual([{ n: 2 }]);
  });

  it("deletes old contact messages and strips addresses from old email logs, keeping recent ones", async () => {
    const [{ summary }] = await rows<{ summary: any }>("SELECT apply_privacy_retention(false) summary");
    expect(summary).toEqual({ dry_run: false, contact_messages_deleted: 1, email_messages_anonymized: 1 });
    expect(await rows("SELECT email FROM contact_messages")).toEqual([{ email: "someone@example.test" }]);
    const mail = await rows("SELECT recipient, status FROM email_messages ORDER BY id");
    expect(mail).toEqual([
      { recipient: "reader@example.test", status: "delivered" },
      { recipient: "reader@example.test", status: "queued" },
      { recipient: "removed", status: "delivered" },
    ]);
    const [{ summary: again }] = await rows<{ summary: any }>("SELECT apply_privacy_retention(false) summary");
    expect(again).toEqual({ dry_run: false, contact_messages_deleted: 0, email_messages_anonymized: 0 });
  });

  it("can't be called by visitors or signed-in accounts", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec("SAVEPOINT r");
      await db.exec(`SET LOCAL ROLE ${role}`);
      await expect(db.query("SELECT apply_privacy_retention(false)")).rejects.toThrow(/permission denied/);
      await db.exec("ROLLBACK TO r");
    }
  });
});
