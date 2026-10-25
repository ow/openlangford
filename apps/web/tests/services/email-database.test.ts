import {
  createAlertHandler,
  dispatchOne,
  type Rpc,
} from "../../../../supabase/functions/_shared/alerts";
import { createEmailEventHandler } from "../../../../supabase/functions/_shared/email-events";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { readFileSync } from "node:fs";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
let db: PGlite;
const uid = "11111111-1111-4111-8111-111111111111";
const text = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
async function consent(enabled = true, id = uid) {
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.query("SELECT set_email_alert_consent($1)", [enabled]);
}
async function enqueue(test: string | null = null, meeting = 1) {
  return (
    await db.query<{ n: number }>(
      "SELECT enqueue_meeting_emails($1,current_date,$2) n",
      [meeting, test],
    )
  ).rows[0].n;
}
async function claim(test: string | null = null) {
  return (await db.query<any>("SELECT * FROM claim_email_alert($1)", [test]))
    .rows[0];
}
beforeAll(async () => {
  db = new PGlite({ extensions: { vector } });
  await db.exec(text("../fixtures/email-schema.sql"));
  await db.exec(
    text("../../../../supabase/migrations/47-20-application-email-ledger.sql"),
  );
  await db.exec(
    text("../../../../supabase/migrations/47-21-per-meeting-email-alerts.sql"),
  );
}, 30000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec("BEGIN");
});
afterEach(async () => {
  await db.exec("ROLLBACK");
});
it("requires consent evidence, a confirmed account email and supported frequency; incomplete legacy preferences are not activated", async () => {
  expect(await enqueue()).toBe(0);
  await consent();
  expect(await enqueue()).toBe(1);
  await db.exec("DELETE FROM email_messages");
  for (const change of [
    "notification_email='other@example.test'",
    "digest_frequency='weekly'",
    "email_alerts_enabled=false",
  ]) {
    await db.exec("SAVEPOINT choice");
    await db.exec(`UPDATE user_profiles SET ${change} WHERE id='${uid}'`);
    expect(await enqueue()).toBe(0);
    await db.exec("ROLLBACK TO choice");
  }
  await expect(
    consent(true, "22222222-2222-4222-8222-222222222222"),
  ).rejects.toThrow("Confirm your sign-in");
});
it("preserves completed explicit per-meeting digest choices without inventing a consent timestamp", async () => {
  await db.exec(
    `UPDATE user_profiles SET onboarding_completed=true WHERE id='${uid}'`,
  );
  await db.exec(
    text(
      "../../../../supabase/migrations/47-21-per-meeting-email-alerts.sql",
    ).replace(/^BEGIN;|^COMMIT;/gm, ""),
  );
  const profile = (
    await db.query<any>(
      "SELECT email_alerts_enabled,email_alerts_consent_at,email_alerts_consent_version FROM user_profiles WHERE id=$1",
      [uid],
    )
  ).rows[0];
  expect(profile).toEqual({
    email_alerts_enabled: true,
    email_alerts_consent_at: null,
    email_alerts_consent_version: "legacy-digest-v1",
  });
  expect(await enqueue()).toBe(1);
  const msg = await claim();
  expect(
    (
      await db.query<any>("SELECT email_alert_eligible($1,current_date) ok", [
        msg.id,
      ])
    ).rows[0].ok,
  ).toBe(true);
});
it("rejects catch-up, future, agenda-only and other-municipality messages, while allowing an exact test recipient outside the live cutoff", async () => {
  await consent();
  expect(await enqueue(null, 2)).toBe(0);
  expect(await enqueue(null, 3)).toBe(0);
  expect(await enqueue(null, 4)).toBe(0);
  expect(await enqueue("wrong@example.test", 2)).toBe(0);
  expect(await enqueue("reader@example.test", 2)).toBe(1);
  expect(await claim()).toBeUndefined();
  expect((await claim("reader@example.test")).is_test).toBe(true);
});
it("matches saved topics, matters, people and current numeric/JSON proximity fields when all-meeting digests are off", async () => {
  await consent();
  await db.exec(
    `UPDATE user_profiles SET digest_enabled=false WHERE id='${uid}'`,
  );
  expect(await enqueue()).toBe(0);
  for (const [type, target] of [
    ["topic", "topic_id"],
    ["matter", "matter_id"],
    ["person", "person_id"],
    ["neighborhood", "neighborhood"],
  ] as const) {
    await db.exec("SAVEPOINT subscription");
    const value =
      type === "person" ? "99" : type === "neighborhood" ? "'Downtown'" : "1";
    await db.exec(
      `INSERT INTO subscriptions(id,user_id,type,is_active,${target}) VALUES(1,'${uid}','${type}',true,${value})`,
    );
    expect(await enqueue()).toBe(1);
    await db.exec("ROLLBACK TO subscription");
  }
  await db.exec(
    `INSERT INTO subscriptions(id,user_id,type,is_active) VALUES(1,'${uid}','neighborhood',true)`,
  );
  expect(await enqueue()).toBe(1);
});
it("persists one logical email across duplicate ingestion, leases only one attempt and freezes the first provider payload", async () => {
  await consent();
  expect(await enqueue()).toBe(1);
  expect(await enqueue()).toBe(0);
  const msg = await claim();
  expect(await claim()).toBeUndefined();
  const freeze = (body: any) =>
    db.query<any>("SELECT freeze_email_alert($1,$2,$3) body", [
      msg.id,
      msg.lease_token,
      JSON.stringify(body),
    ]);
  expect((await freeze({ subject: "First" })).rows[0].body).toEqual({
    subject: "First",
  });
  expect((await freeze({ subject: "Changed" })).rows[0].body).toEqual({
    subject: "First",
  });
  expect((await db.query("SELECT * FROM email_events")).rows).toHaveLength(1);
});
it("durably requeues transient failures with the same ID/body, rejects stale leases and caps retry lifetime", async () => {
  await consent();
  await enqueue();
  const first = await claim();
  await db.query("SELECT finish_email_alert($1,$2,$3,$4,$5,$6)", [
    first.id,
    first.lease_token,
    "retry",
    null,
    "Provider timeout",
    30,
  ]);
  expect(await claim()).toBeUndefined();
  await db.exec(
    "UPDATE email_messages SET next_attempt_at=now()-interval '1 second'",
  );
  const next = await claim();
  expect(next.id).toBe(first.id);
  expect(next.attempt_count).toBe(2);
  const stale = await db.query<any>("SELECT finish_email_alert($1,$2,$3) ok", [
    first.id,
    first.lease_token,
    "accepted",
  ]);
  expect(stale.rows[0].ok).toBe(false);
  await db.exec(
    "UPDATE email_messages SET expires_at=now()-interval '1 second'",
  );
  expect(await claim()).toBeUndefined();
  expect(
    (await db.query<any>("SELECT status FROM email_messages")).rows[0].status,
  ).toBe("failed");
});
it("preserves queued consent on ordinary settings saves, but rejects stale messages after an opt-out and renewed opt-in", async () => {
  await consent();
  await enqueue();
  const before = (await db.query<any>("SELECT consent_at FROM email_messages"))
    .rows[0].consent_at;
  await consent();
  const msg = await claim();
  expect(msg.consent_at).toEqual(before);
  expect(
    (
      await db.query<any>("SELECT email_alert_eligible($1,current_date) ok", [
        msg.id,
      ])
    ).rows[0].ok,
  ).toBe(true);
  await consent(false);
  await consent(true);
  expect(
    (
      await db.query<any>("SELECT email_alert_eligible($1,current_date) ok", [
        msg.id,
      ])
    ).rows[0].ok,
  ).toBe(false);
});
it("never requeues known acceptance when a signed sent event races an HTTP timeout", async () => {
  await consent();
  await enqueue();
  const msg = await claim();
  const provider = "33333333-3333-4333-8333-333333333333";
  await db.query("SELECT record_email_provider_event($1,$2,$3,now(),$4,$5)", [
    "msg_accepted",
    provider,
    "accepted",
    msg.id,
    msg.recipient,
  ]);
  await db.query("SELECT finish_email_alert($1,$2,$3,$4,$5)", [
    msg.id,
    msg.lease_token,
    "retry",
    null,
    "Network timeout",
  ]);
  expect(
    (
      await db.query<any>(
        "SELECT status,provider_message_id FROM email_messages",
      )
    ).rows[0],
  ).toEqual({ status: "accepted", provider_message_id: provider });
  expect(await claim()).toBeUndefined();
});
it("unsubscribe suppresses queued delivery immediately and only explicit renewed consent clears an unsubscribe, never a bounce/complaint", async () => {
  await consent();
  await enqueue();
  const msg = await claim();
  expect(
    (
      await db.query<any>("SELECT email_alert_eligible($1,current_date) ok", [
        msg.id,
      ])
    ).rows[0].ok,
  ).toBe(true);
  await db.query("SELECT unsubscribe_email_alerts($1)", [
    msg.unsubscribe_token,
  ]);
  expect(
    (
      await db.query<any>("SELECT email_alert_eligible($1,current_date) ok", [
        msg.id,
      ])
    ).rows[0].ok,
  ).toBe(false);
  expect(
    (
      await db.query<any>(
        "SELECT email_alerts_enabled FROM user_profiles WHERE id=$1",
        [uid],
      )
    ).rows[0].email_alerts_enabled,
  ).toBe(false);
  await consent();
  expect(
    (await db.query("SELECT * FROM email_suppressions")).rows,
  ).toHaveLength(0);
  await db.exec(
    "INSERT INTO email_suppressions(recipient,reason) VALUES('reader@example.test','complained')",
  );
  await consent();
  expect(await enqueue()).toBe(0);
});
it("deduplicates verified provider events, supports early webhook correlation, and never downgrades delivered or complaint states", async () => {
  await consent();
  await enqueue();
  const msg = await claim();
  const provider = "33333333-3333-4333-8333-333333333333";
  const event = async (id: string, type: string) =>
    db.query("SELECT record_email_provider_event($1,$2,$3,now(),$4,$5)", [
      id,
      provider,
      type,
      msg.id,
      msg.recipient,
    ]);
  await event("msg_delivered", "delivered");
  await event("msg_delivered", "delivered");
  await event("msg_sent", "accepted");
  expect(
    (await db.query<any>("SELECT status FROM email_messages")).rows[0].status,
  ).toBe("delivered");
  await event("msg_spam", "complained");
  await event("msg_late", "delivered");
  expect(
    (await db.query<any>("SELECT status FROM email_messages")).rows[0].status,
  ).toBe("complained");
  expect(
    (await db.query<any>("SELECT reason FROM email_suppressions")).rows[0]
      .reason,
  ).toBe("complained");
  expect((await db.query("SELECT * FROM email_events")).rows).toHaveLength(5); // attempt + four distinct provider events
});
it.each(["anon", "authenticated"])(
  "denies %s private queue, suppression and delivery-RPC access",
  async (role) => {
    await db.exec(`SET LOCAL ROLE ${role}`);
    for (const sql of [
      "SELECT * FROM email_messages",
      "SELECT * FROM email_suppressions",
      "SELECT * FROM claim_email_alert(null)",
      "SELECT enqueue_meeting_emails(1,current_date,null)",
    ]) {
      await db.exec("SAVEPOINT denied");
      await expect(db.exec(sql)).rejects.toMatchObject({ code: "42501" });
      await db.exec("ROLLBACK TO denied");
    }
  },
);
it("consent RPC derives the caller identity and cannot change another account", async () => {
  await db.exec(
    `SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${uid}',false)`,
  );
  await db.exec("SELECT set_email_alert_consent(true)");
  const own = await db.query<any>(
    "SELECT email_alerts_enabled FROM user_profiles",
  );
  expect(own.rows).toEqual([{ email_alerts_enabled: true }]);
  await db.exec("RESET ROLE");
  expect(
    (
      await db.query<any>(
        "SELECT email_alerts_enabled FROM user_profiles WHERE id='22222222-2222-4222-8222-222222222222'",
      )
    ).rows[0].email_alerts_enabled,
  ).toBe(false);
});

it("runs the real queue RPC contracts through dispatch and a signed provider event using only in-memory data and fake transport", async () => {
  await consent();
  const scalar = new Set([
    "enqueue_meeting_emails",
    "email_alert_eligible",
    "freeze_email_alert",
    "finish_email_alert",
    "record_email_provider_event",
  ]);
  const rpc: Rpc = async (name, args) => {
    if (!scalar.has(name) && name !== "claim_email_alert")
      throw new Error("Unexpected RPC");
    const entries = Object.entries(args),
      bindings = entries.map(([, value]) =>
        value && typeof value === "object" ? JSON.stringify(value) : value,
      );
    const named = entries
      .map(([key], index) => `${key} => $${index + 1}`)
      .join(",");
    const result = await db.query<any>(
      name === "claim_email_alert"
        ? `SELECT * FROM public.${name}(${named})`
        : `SELECT public.${name}(${named}) AS result`,
      bindings,
    );
    return {
      data: name === "claim_email_alert" ? result.rows : result.rows[0].result,
      error: null,
    };
  };
  const env = {
    ALERT_WORKER_KEY: "synthetic-integration-worker-key-123",
    ALERT_DELIVERY_MODE: "test",
    ALERT_START_DATE: new Date().toISOString().slice(0, 10),
    ALERT_TEST_RECIPIENT: "reader@example.test",
    RESEND_API_KEY: "synthetic-provider-key",
  };
  const provider = "33333333-3333-4333-8333-333333333333",
    send = vi.fn().mockResolvedValue(Response.json({ id: provider }));
  const response = await createAlertHandler(
    env,
    rpc,
    send,
  )(
    new Request("https://edge.test/send-alerts", {
      method: "POST",
      headers: { "X-Alert-Worker-Key": env.ALERT_WORKER_KEY },
      body: JSON.stringify({ action: "test", meeting_id: 1 }),
    }),
  );
  expect(await response.json()).toEqual({ queued: 1 });
  await dispatchOne(env, rpc, send);
  expect(send).toHaveBeenCalledTimes(1);
  const row = (
    await db.query<any>(
      "SELECT id,status,provider_message_id FROM email_messages",
    )
  ).rows[0];
  expect(row.status).toBe("accepted");
  expect(row.provider_message_id).toBe(provider);
  const body = JSON.parse(send.mock.calls[0][1].body);
  const payload = JSON.stringify({
    type: "email.delivered",
    created_at: new Date().toISOString(),
    data: {
      email_id: provider,
      to: body.to,
      tags: Object.fromEntries(
        body.tags.map((tag: any) => [tag.name, tag.value]),
      ),
    },
  });
  const stamp = String(Math.floor(Date.now() / 1000)),
    eventId = "msg_integration",
    secret = btoa("synthetic-integration-hmac-key-32");
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(secret), (c) => c.charCodeAt(0)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${eventId}.${stamp}.${payload}`),
    ),
  );
  const eventResponse = await createEmailEventHandler(
    "whsec_" + secret,
    rpc,
  )(
    new Request("https://edge.test/email-events", {
      method: "POST",
      headers: {
        "svix-id": eventId,
        "svix-timestamp": stamp,
        "svix-signature": "v1," + btoa(String.fromCharCode(...signature)),
      },
      body: payload,
    }),
  );
  expect(eventResponse.status).toBe(204);
  expect(
    (await db.query<any>("SELECT status FROM email_messages")).rows[0].status,
  ).toBe("delivered");
});
