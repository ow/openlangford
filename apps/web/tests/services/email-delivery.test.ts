import { beforeEach, expect, it, vi, type Mock } from "vitest";
import {
  createAlertHandler,
  dispatchOne,
  providerBody,
  FROM_EMAIL,
  type Message,
  type Rpc,
} from "../../../../supabase/functions/_shared/alerts";
import { createEmailEventHandler } from "../../../../supabase/functions/_shared/email-events";
const id = "11111111-1111-4111-8111-111111111111",
  lease = "22222222-2222-4222-8222-222222222222",
  provider = "33333333-3333-4333-8333-333333333333";
const env = {
  ALERT_WORKER_KEY: "synthetic-test-worker-key-1234567890",
  ALERT_DELIVERY_MODE: "test",
  ALERT_START_DATE: "2026-10-25",
  ALERT_TEST_RECIPIENT: "reader@example.test",
  RESEND_API_KEY: "synthetic-provider-key",
};
let msg: Message, rpc: Mock<Rpc>, send: any;
beforeEach(() => {
  msg = {
    id,
    recipient: "reader@example.test",
    subject: "Council update",
    payload: {
      meeting: {
        id: 1,
        title: "Council <script>alert(1)</script>",
        slug: "council-test",
        date: "2026-10-25",
        summary: "A park plan was approved.",
      },
      decisions: [
        {
          title: "Park",
          summary: "<img src=x onerror=alert(1)>",
          result: "CARRIED",
        },
      ],
    },
    unsubscribe_token: lease,
    lease_token: lease,
    attempt_count: 1,
    is_test: true,
  };
  rpc = vi.fn(async (name: string, args: any) => ({
    data:
      name === "claim_email_alert"
        ? [msg]
        : name === "email_alert_eligible"
          ? true
          : name === "freeze_email_alert"
            ? args.p_body
            : true,
    error: null,
  }));
  send = vi.fn().mockResolvedValue(Response.json({ id: provider }));
});
function request(body: any, key = env.ALERT_WORKER_KEY) {
  return new Request("https://edge.test/send-alerts", {
    method: "POST",
    headers: { "X-Alert-Worker-Key": key },
    body: JSON.stringify(body),
  });
}
it.each(["", "wrong-key"])(
  "rejects an unauthorized invocation before database/provider access",
  async (key) => {
    expect(
      (
        await createAlertHandler(
          env,
          rpc,
          send,
        )(request({ action: "dispatch" }, key))
      ).status,
    ).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  },
);
it("defaults off and requires an explicit valid cutoff and exact recipient configuration", async () => {
  const off = { ...env, ALERT_DELIVERY_MODE: undefined };
  expect(
    await (
      await createAlertHandler(off, rpc, send)(request({ action: "dispatch" }))
    ).json(),
  ).toHaveProperty("skipped", true);
  expect(rpc).not.toHaveBeenCalled();
  expect(
    (
      await createAlertHandler(
        { ...env, ALERT_START_DATE: undefined },
        rpc,
        send,
      )(request({ action: "dispatch" }))
    ).status,
  ).toBe(503);
  expect(
    (
      await createAlertHandler(
        { ...env, ALERT_TEST_RECIPIENT: undefined },
        rpc,
        send,
      )(request({ action: "test", meeting_id: 1 }))
    ).status,
  ).toBe(503);
  expect(send).not.toHaveBeenCalled();
});
it("keeps pipeline ingestion out of test mode and permits only its configured test address, not a body-supplied recipient", async () => {
  const handler = createAlertHandler(env, rpc, send);
  expect(
    await (await handler(request({ action: "enqueue", meeting_id: 1 }))).json(),
  ).toHaveProperty("skipped", true);
  expect(rpc).not.toHaveBeenCalled();
  await handler(
    request({
      action: "test",
      meeting_id: 1,
      email: "someone-else@example.test",
    }),
  );
  expect(rpc).toHaveBeenCalledWith("enqueue_meeting_emails", {
    p_meeting: 1,
    p_start_date: "2026-10-25",
    p_test_recipient: "reader@example.test",
  });
  expect(send).not.toHaveBeenCalled();
});
it("rejects unsupported pre-meeting/weekly operations and malformed ingestion before queue access", async () => {
  const handler = createAlertHandler(
    { ...env, ALERT_DELIVERY_MODE: "live" },
    rpc,
    send,
  );
  for (const body of [
    { action: "pre_meeting", meeting_id: 1 },
    { action: "enqueue", meeting_id: 1, mode: "weekly" },
    { action: "enqueue", meeting_id: "1" },
  ])
    expect((await handler(request(body))).status).toBe(400);
  expect(rpc).not.toHaveBeenCalled();
});
it("sends escaped Langford HTML plus text and one-click unsubscribe headers, then records acceptance instead of delivery", async () => {
  await dispatchOne(env, rpc, send);
  const call = send.mock.calls[0];
  expect(call[0]).toBe("https://api.resend.com/emails");
  const body = JSON.parse(call[1].body);
  expect(body.from).toBe(FROM_EMAIL);
  expect(body.to).toEqual(["reader@example.test"]);
  expect(body.html).not.toContain("<script>");
  expect(body.html).not.toContain("<img");
  expect(body.text).toContain("A park plan was approved.");
  expect(body.headers["List-Unsubscribe"]).toBe(
    `<https://openlangford.ca/email/unsubscribe/${lease}>`,
  );
  expect(body.headers["List-Unsubscribe-Post"]).toBe(
    "List-Unsubscribe=One-Click",
  );
  expect(JSON.stringify(body)).not.toContain("viewroyal.ai");
  expect(rpc).toHaveBeenLastCalledWith(
    "finish_email_alert",
    expect.objectContaining({ p_state: "accepted", p_provider_id: provider }),
  );
});
it.each([429, 500])(
  "durably schedules retry after provider HTTP %s without recording response bodies or marking delivered",
  async (status) => {
    send.mockResolvedValue(
      new Response("secret provider diagnostics", {
        status,
        headers: { "retry-after": "120" },
      }),
    );
    await dispatchOne(env, rpc, send);
    expect(rpc).toHaveBeenLastCalledWith(
      "finish_email_alert",
      expect.objectContaining({
        p_state: "retry",
        p_retry_seconds: 120,
        p_error: `Provider HTTP ${status}`,
      }),
    );
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(
      "secret provider diagnostics",
    );
  },
);
it("keeps a stable provider key and frozen payload after an ambiguous network failure and a code/content change", async () => {
  const frozen = providerBody(msg);
  let first = true;
  rpc.mockImplementation(async (name: string, args: any) => ({
    data:
      name === "claim_email_alert"
        ? [msg]
        : name === "email_alert_eligible"
          ? true
          : name === "freeze_email_alert"
            ? frozen
            : true,
    error: null,
  }));
  send.mockImplementation(async () => {
    if (first) {
      first = false;
      throw Error("Socket failed including sensitive context");
    }
    return Response.json({ id: provider });
  });
  await dispatchOne(env, rpc, send);
  msg.payload.meeting.summary = "Changed after first attempt";
  await dispatchOne(env, rpc, send);
  expect(send.mock.calls[0][1].body).toBe(send.mock.calls[1][1].body);
  expect(send.mock.calls[0][1].headers["Idempotency-Key"]).toBe(
    send.mock.calls[1][1].headers["Idempotency-Key"],
  );
  expect(rpc).toHaveBeenCalledWith(
    "finish_email_alert",
    expect.objectContaining({
      p_state: "retry",
      p_error: "Provider network outcome unknown",
    }),
  );
});
it("stops changed consent or a poisoned stored recipient before any provider request", async () => {
  let eligibilityChecks = 0;
  rpc.mockImplementation(async (name: string, args: any) => ({
    data:
      name === "claim_email_alert"
        ? [msg]
        : name === "email_alert_eligible"
          ? ++eligibilityChecks === 1
          : name === "freeze_email_alert"
            ? args.p_body
            : true,
    error: null,
  }));
  await dispatchOne(env, rpc, send);
  expect(send).not.toHaveBeenCalled();
  msg.provider_payload = { ...providerBody(msg), to: ["other@example.test"] };
  eligibilityChecks = 0;
  await dispatchOne(env, rpc, send);
  expect(send).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenLastCalledWith(
    "finish_email_alert",
    expect.objectContaining({ p_state: "failed" }),
  );
});
it("rejects stored cc/bcc even when the primary test recipient matches", async () => {
  msg.provider_payload = { ...providerBody(msg), bcc: ["other@example.test"] };
  await dispatchOne(env, rpc, send);
  expect(send).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenLastCalledWith(
    "finish_email_alert",
    expect.objectContaining({ p_state: "failed" }),
  );
});
it("treats permanent errors as failed and malformed success acknowledgements as an ambiguous retry", async () => {
  send.mockResolvedValue(new Response("not logged", { status: 403 }));
  await dispatchOne(env, rpc, send);
  expect(rpc).toHaveBeenLastCalledWith(
    "finish_email_alert",
    expect.objectContaining({
      p_state: "failed",
      p_error: "Provider HTTP 403",
    }),
  );
  send.mockResolvedValue(Response.json({ unexpected: "body" }));
  await dispatchOne(env, rpc, send);
  expect(rpc).toHaveBeenLastCalledWith(
    "finish_email_alert",
    expect.objectContaining({ p_state: "retry" }),
  );
});

const secret = "whsec_" + btoa("synthetic-webhook-secret-32-bytes!");
async function signed(
  body: string,
  stamp = Math.floor(Date.now() / 1000),
  signatureSecret = secret,
) {
  const eventId = "msg_syntheticEvent";
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(signatureSecret.slice(6)), (c) => c.charCodeAt(0)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${eventId}.${stamp}.${body}`),
    ),
  );
  return new Request("https://edge.test/email-events", {
    method: "POST",
    headers: {
      "svix-id": eventId,
      "svix-timestamp": String(stamp),
      "svix-signature": "v1," + btoa(String.fromCharCode(...sig)),
    },
    body,
  });
}
function event(type = "email.delivered") {
  return JSON.stringify({
    type,
    created_at: "2026-10-25T12:00:00Z",
    data: {
      email_id: provider,
      to: ["reader@example.test"],
      tags: { message_id: id },
      html: "never persist raw payload",
    },
  });
}
it("accepts only signed raw-body provider events and projects minimal delivery metadata", async () => {
  await createEmailEventHandler(secret, rpc)(await signed(event()));
  expect(rpc).toHaveBeenCalledWith("record_email_provider_event", {
    p_event_id: "msg_syntheticEvent",
    p_provider_id: provider,
    p_type: "delivered",
    p_at: "2026-10-25T12:00:00Z",
    p_message: id,
    p_recipient: "reader@example.test",
  });
  expect(JSON.stringify(rpc.mock.calls)).not.toContain("never persist");
});
it("rejects stale or tampered events without database access; ignores unrelated Auth/unclassified events", async () => {
  const handler = createEmailEventHandler(secret, rpc);
  expect(
    (await handler(await signed(event(), Math.floor(Date.now() / 1000) - 600)))
      .status,
  ).toBe(400);
  const valid = await signed(event());
  const tampered = new Request(valid, {
    body: event().replace("delivered", "bounced"),
  });
  expect((await handler(tampered)).status).toBe(400);
  expect(rpc).not.toHaveBeenCalled();
  expect((await handler(await signed(event("email.opened")))).status).toBe(204);
  expect(rpc).not.toHaveBeenCalled();
});
it("makes provider retry when persistence fails instead of acknowledging a lost delivery event", async () => {
  rpc.mockResolvedValue({ data: null, error: { message: "private failure" } });
  expect(
    (await createEmailEventHandler(secret, rpc)(await signed(event()))).status,
  ).toBe(503);
});

it("returns a retryable provider response when the database transport throws", async () => {
  rpc.mockRejectedValue(new Error("private transport details"));
  const response = await createEmailEventHandler(
    secret,
    rpc,
  )(await signed(event()));
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private transport details");
});

// ── Before-meeting agenda previews ──
const preview = (over: Record<string, unknown> = {}) => ({
  kind: "agenda_preview",
  updated: false,
  every_meeting: false,
  meeting: { id: 2, slug: "2026-11-24-regular-council", title: "Regular Council", date: "2026-11-24", start_time: "19:00", venue: null, address: null },
  items: [
    { id: 21, title: "Application to rezone 953 Walfred Road", summary: "A proposal for 47 homes <b>near</b> the school.", category: "Housing", public_hearing: false, reasons: [{ type: "topic", label: "Housing" }] },
    { id: 23, title: "Station Avenue homes", summary: null, category: "Land Use", public_hearing: true, reasons: [{ type: "nearby", label: "Station Avenue" }, { type: "keyword", label: "station avenue" }] },
    { id: 24, title: "Parks budget", summary: "Money for two new parks.", category: "Finance", public_hearing: false, reasons: [{ type: "neighborhood", label: "Westhills" }] },
  ],
  item_ids: [21, 23, 24],
  ...over,
});
it("renders an agenda preview: when and where, why each item is there, and how to have a say", () => {
  const body = providerBody({ ...msg, subject: "Coming up at council: Regular Council, November 24", is_test: false, payload: preview() });
  expect(body.subject).toBe("Coming up at council: Regular Council, November 24");
  expect(body.html).toContain("Coming up at council");
  expect(body.text).toContain("Tuesday, November 24, 2026 at 7 pm");
  expect(body.text).toContain("Council Chambers, third floor of City Hall, 877 Goldstream Avenue");
  expect(body.text).toContain("This agenda includes 3 things you follow.");
  expect(body.html).toContain('href="https://openlangford.ca/meetings/2026-11-24-regular-council#item-21"');
  expect(body.text).toContain("You follow Housing.");
  expect(body.text).toContain("It is near Station Avenue, close to your saved place. It matches your saved search “station avenue”.");
  expect(body.text).toContain("It is in Westhills, a neighbourhood you follow.");
  // Public hearing: speak or write beforehand; planning items: write to planning; others: the feedback form.
  expect(body.text).toContain("This is a public hearing. Anyone can speak at the meeting");
  expect(body.text).toContain("The City's notice for the hearing gives the deadline");
  expect(body.text).toContain("Write to Council before the meeting at planning@langford.ca");
  expect(body.text).toContain("https://langford.ca/city-hall/council-committees/mayor-council/#feedback-form");
  expect(body.html.match(/Have your say/g)).toHaveLength(3);
  // Escaped, with the per-type off switch and the all-alerts unsubscribe.
  expect(body.html).not.toContain("<b>near</b>");
  expect(body.html).toContain("&lt;b&gt;near&lt;/b&gt;");
  expect(body.text).toContain("turn off “Before meetings” in your settings: https://openlangford.ca/settings");
  expect(body.text).toContain(`Unsubscribe from all council alert emails: https://openlangford.ca/email/unsubscribe/${lease}`);
  expect(body.headers["List-Unsubscribe"]).toBe(`<https://openlangford.ca/email/unsubscribe/${lease}>`);
  // No database words in what a resident reads.
  expect(body.text).not.toMatch(/\bmatters?\b|agenda items?|\brecords?\b/i);
});
it("says when the agenda changed, handles every-meeting subscribers, and refuses an empty preview", () => {
  const updated = providerBody({ ...msg, payload: preview({ updated: true, items: [{ id: 30, title: "Library hours", summary: null, category: "Community Services", public_hearing: false, reasons: [] }] }) });
  expect(updated.text).toContain("The agenda has changed since our last email.");
  expect(updated.text).toContain("Here is what is on the agenda.");
  expect(updated.text).toContain("You asked for every council meeting.");
  expect(updated.text).toContain("TEST EMAIL");
  expect(providerBody({ ...msg, payload: preview({ meeting: { ...preview().meeting, start_time: "17:30", venue: "Langford Fire Hall" } }) }).text).toContain(
    "at 5:30 pm\nLangford Fire Hall",
  );
  expect(() => providerBody({ ...msg, payload: preview({ items: [] }) })).toThrow("Invalid queued payload");
});
it("queues agenda previews through the agenda mode only", async () => {
  const handler = createAlertHandler({ ...env, ALERT_DELIVERY_MODE: "live" }, rpc, send);
  rpc.mockResolvedValue({ data: 2, error: null });
  expect(await (await handler(request({ action: "enqueue", meeting_id: 7, mode: "agenda" }))).json()).toEqual({ queued: 2 });
  expect(rpc).toHaveBeenCalledWith("enqueue_agenda_alert_emails", { p_meeting: 7, p_start_date: "2026-10-25", p_test_recipient: null });
  await handler(request({ action: "enqueue", meeting_id: 7, mode: "digest" }));
  expect(rpc).toHaveBeenLastCalledWith("enqueue_meeting_emails", { p_meeting: 7, p_start_date: "2026-10-25", p_test_recipient: null });
  expect(send).not.toHaveBeenCalled();
});
