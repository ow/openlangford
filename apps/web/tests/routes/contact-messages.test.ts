import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildContactNotification,
  notifyContactMessage,
  replyMailto,
} from "~/services/contact-messages.server";

const mocks = vi.hoisted(() => ({ user: vi.fn(), adminClient: vi.fn() }));
vi.mock("~/lib/supabase.server", () => ({
  createSupabaseServerClient: () => ({ supabase: { auth: { getUser: mocks.user } }, headers: new Headers() }),
  getSupabaseAdminClient: mocks.adminClient,
}));

import * as adminContact from "~/routes/admin-contact";
import * as contact from "~/routes/contact";

/** Chainable Supabase stand-in: records every call; each awaited query resolves to the next queued result. */
function fakeSupabase(results: any[] = []) {
  const calls: { table: string; ops: [string, any[]][] }[] = [];
  const client = {
    calls,
    from(table: string) {
      const entry = { table, ops: [] as [string, any[]][] };
      calls.push(entry);
      const builder: any = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") {
              const result = results.shift() ?? { data: null, error: null };
              return (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
            }
            return (...args: any[]) => {
              entry.ops.push([prop, args]);
              return builder;
            };
          },
        },
      );
      return builder;
    },
  };
  return client;
}

const ADMIN = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "admin@example.com", email_confirmed_at: "2026-01-01T00:00:00Z" };
const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ADMIN_EMAILS", "admin@example.com, second@example.com");
  vi.stubEnv("ADMIN_EMAIL", "");
  mocks.adminClient.mockImplementation(() => {
    throw new Error("Unexpected privileged database access");
  });
  mocks.user.mockResolvedValue({ data: { user: ADMIN } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function caught(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as Response;
  }
  throw new Error("expected a thrown response");
}

describe("admin guard", () => {
  it("returns 403 to signed-in non-admins for both list and actions, before touching the database", async () => {
    mocks.user.mockResolvedValue({ data: { user: { id: "reader", email: "reader@example.com" } } });
    const read = await caught(adminContact.loader({ request: new Request("https://openlangford.ca/admin/contact") } as any));
    expect(read.status).toBe(403);
    expect(read.headers.get("Cache-Control")).toBe("private, no-store");
    const body = new URLSearchParams({ intent: "handle", id: MESSAGE_ID });
    const write = await caught(adminContact.action({ request: new Request("https://openlangford.ca/admin/contact", { method: "POST", body }) } as any));
    expect(write.status).toBe(403);
    expect(mocks.adminClient).not.toHaveBeenCalled();
  });

  it("redirects signed-out visitors to login", async () => {
    mocks.user.mockResolvedValue({ data: { user: null } });
    const response = await caught(adminContact.loader({ request: new Request("https://openlangford.ca/admin/contact") } as any));
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login?redirectTo=%2Fadmin%2Fcontact");
  });
});

describe("list and filter", () => {
  const row = { id: MESSAGE_ID, name: "A", email: "a@example.com", message: "hi", created_at: "2026-10-29T18:00:00Z", handled_at: null, notified_at: null };

  it.each([
    ["", "open", ["is", ["handled_at", null]]],
    ["?show=handled", "handled", ["not", ["handled_at", "is", null]]],
    ["?show=all", "all", null],
    ["?show=bogus", "open", ["is", ["handled_at", null]]],
  ] as const)("filter %s lists newest first without client_ip", async (search, filter, expected) => {
    const db = fakeSupabase([{ data: [row], error: null }, { count: 3, error: null }]);
    mocks.adminClient.mockReturnValue(db);
    const result: any = await adminContact.loader({ request: new Request(`https://openlangford.ca/admin/contact${search}`) } as any);
    expect(result.data).toEqual({ filter, messages: [row], openCount: 3 });
    expect(result.init.headers.get("Cache-Control")).toBe("private, no-store");
    const list = db.calls[0];
    expect(list.table).toBe("contact_messages");
    const select = list.ops.find(([op]) => op === "select")![1][0] as string;
    expect(select).not.toContain("client_ip");
    expect(list.ops).toContainEqual(["order", ["created_at", { ascending: false }]]);
    const filters = list.ops.filter(([op]) => op === "is" || op === "not");
    expect(filters).toEqual(expected ? [expected] : []);
    // Open-count query backs the badge on the Open filter.
    expect(db.calls[1].ops).toContainEqual(["is", ["handled_at", null]]);
  });

  it("returns a generic 503 when the database errors", async () => {
    mocks.adminClient.mockReturnValue(fakeSupabase([{ data: null, error: { message: "secret detail" } }, { count: 0, error: null }]));
    const response = await caught(adminContact.loader({ request: new Request("https://openlangford.ca/admin/contact") } as any));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret detail");
  });
});

describe("mark handled / reopen", () => {
  function post(body: Record<string, string>) {
    return adminContact.action({
      request: new Request("https://openlangford.ca/admin/contact", { method: "POST", body: new URLSearchParams(body) }),
    } as any) as Promise<any>;
  }

  it("marks a message handled by the signed-in admin", async () => {
    const db = fakeSupabase([{ error: null }]);
    mocks.adminClient.mockReturnValue(db);
    const result = await post({ intent: "handle", id: MESSAGE_ID });
    expect(result.data).toEqual({ ok: true });
    const update = db.calls[0].ops.find(([op]) => op === "update")![1][0];
    expect(update.handled_by).toBe(ADMIN.id);
    expect(typeof update.handled_at).toBe("string");
    expect(db.calls[0].ops).toContainEqual(["eq", ["id", MESSAGE_ID]]);
  });

  it("reopens a message by clearing handled fields", async () => {
    const db = fakeSupabase([{ error: null }]);
    mocks.adminClient.mockReturnValue(db);
    await post({ intent: "reopen", id: MESSAGE_ID });
    expect(db.calls[0].ops.find(([op]) => op === "update")![1][0]).toEqual({ handled_at: null, handled_by: null });
  });

  it("rejects unknown intents and malformed ids without writing", async () => {
    expect((await post({ intent: "delete", id: MESSAGE_ID })).init.status).toBe(400);
    expect((await caught(post({ intent: "handle", id: "1 OR 1=1" }))).status).toBe(400);
    expect(mocks.adminClient).not.toHaveBeenCalled();
  });
});

describe("notification payload", () => {
  const message = {
    id: MESSAGE_ID,
    name: "Eve <script>alert(1)</script>",
    email: "eve@example.com",
    message: "Line one\n<b>bold</b> & \"quotes\"",
    created_at: "2026-10-29T18:05:00Z",
  };

  it("escapes HTML, sets reply_to, addresses every admin and links the admin page", () => {
    const payload = buildContactNotification(message, ["admin@example.com", "second@example.com"]);
    expect(payload.from).toBe("Open Langford <alerts@openlangford.ca>");
    expect(payload.to).toEqual(["admin@example.com", "second@example.com"]);
    expect(payload.reply_to).toBe("eve@example.com");
    expect(payload.subject).toBe("Contact form: Eve <script>alert(1)</script>");
    expect(payload.html).not.toContain("<script>");
    expect(payload.html).not.toContain("<b>bold</b>");
    expect(payload.html).toContain("&lt;b&gt;bold&lt;/b&gt; &amp; &quot;quotes&quot;");
    expect(payload.html).toContain('href="https://openlangford.ca/admin/contact"');
    expect(payload.text).toContain("Line one\n<b>bold</b>");
    expect(payload.text).toContain("https://openlangford.ca/admin/contact");
    // Civic timezone: 18:05 UTC is 11:05 Pacific (PDT).
    expect(payload.text).toMatch(/11:05/);
  });

  it("uses the email in the subject when no name was given and strips newlines", () => {
    expect(buildContactNotification({ ...message, name: null }, ["a@x.ca"]).subject).toBe("Contact form: eve@example.com");
    expect(buildContactNotification({ ...message, name: "A\r\nBcc: x" }, ["a@x.ca"]).subject).toBe("Contact form: A Bcc: x");
  });

  it("builds a reply mailto with the agreed subject", () => {
    expect(replyMailto("a+b@example.com")).toBe("mailto:a%2Bb@example.com?subject=Re%3A%20your%20message%20to%20Open%20Langford");
  });

  it("no-ops without an API key or recipients", async () => {
    const fetcher = vi.fn();
    const db = fakeSupabase();
    expect(await notifyContactMessage({ apiKey: undefined, recipients: ["a@x.ca"], message, supabase: db as any, fetcher })).toBe("skipped");
    expect(await notifyContactMessage({ apiKey: "re_x", recipients: [], message, supabase: db as any, fetcher })).toBe("skipped");
    expect(fetcher).not.toHaveBeenCalled();
    expect(db.calls).toHaveLength(0);
  });

  it("posts to Resend and records notified_at on success", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const db = fakeSupabase([{ error: null }]);
    expect(await notifyContactMessage({ apiKey: "re_test", recipients: ["a@x.ca"], message, supabase: db as any, fetcher })).toBe("sent");
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers.Authorization).toBe("Bearer re_test");
    expect(JSON.parse(init.body).reply_to).toBe("eve@example.com");
    expect(db.calls[0].ops.find(([op]) => op === "update")![1][0]).toHaveProperty("notified_at");
  });

  it("logs a generic error and leaves notified_at empty when Resend fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = fakeSupabase();
    const fetcher = vi.fn().mockResolvedValue(new Response("bad", { status: 422 }));
    expect(await notifyContactMessage({ apiKey: "re_test", recipients: ["a@x.ca"], message, supabase: db as any, fetcher })).toBe("failed");
    fetcher.mockRejectedValue(new Error("network down"));
    expect(await notifyContactMessage({ apiKey: "re_test", recipients: ["a@x.ca"], message, supabase: db as any, fetcher })).toBe("failed");
    expect(db.calls).toHaveLength(0);
    const logged = log.mock.calls.flat().join(" ");
    expect(logged).not.toContain("eve@example.com");
    expect(logged).not.toContain("a@x.ca");
    expect(logged).not.toContain("Line one");
  });
});

describe("contact form action", () => {
  function submit(fields: Record<string, string>, env: Record<string, string> = {}) {
    const waitUntil = vi.fn();
    const result = contact.action({
      request: new Request("https://openlangford.ca/contact", {
        method: "POST",
        body: new URLSearchParams(fields),
        headers: { "cf-connecting-ip": `203.0.113.${Math.floor(Math.random() * 250)}` },
      }),
      context: { cloudflare: { env, ctx: { waitUntil } } },
    } as any);
    return { result, waitUntil };
  }
  const valid = { name: "Sam", email: "sam@example.com", message: "Hello there, a question." };

  it("emails the admins in the background with reply_to set to the submitter", async () => {
    const db = fakeSupabase([{ data: { id: MESSAGE_ID, created_at: "2026-10-29T18:00:00Z" }, error: null }, { error: null }]);
    mocks.adminClient.mockReturnValue(db);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const { result, waitUntil } = submit(valid, { RESEND_API_KEY: "re_test" });
    expect(await result).toEqual({ ok: true });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0][0];
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.to).toEqual(["admin@example.com", "second@example.com"]);
    expect(body.reply_to).toBe("sam@example.com");
    expect(body.subject).toBe("Contact form: Sam");
  });

  it("still succeeds when Resend errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.adminClient.mockReturnValue(fakeSupabase([{ data: { id: MESSAGE_ID, created_at: "2026-10-29T18:00:00Z" }, error: null }]));
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    const { result, waitUntil } = submit(valid, { RESEND_API_KEY: "re_test" });
    expect(await result).toEqual({ ok: true });
    await expect(waitUntil.mock.calls[0][0]).resolves.toBe("failed");
  });

  it("saves but sends nothing without RESEND_API_KEY", async () => {
    const db = fakeSupabase([{ data: { id: MESSAGE_ID, created_at: "2026-10-29T18:00:00Z" }, error: null }]);
    mocks.adminClient.mockReturnValue(db);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { result, waitUntil } = submit(valid);
    expect(await result).toEqual({ ok: true });
    await waitUntil.mock.calls[0][0];
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.calls).toHaveLength(1);
  });

  it("does not save or notify for honeypot or invalid submissions", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const bot = submit({ ...valid, website: "spam" }, { RESEND_API_KEY: "re_test" });
    expect(await bot.result).toEqual({ ok: true });
    const bad = submit({ ...valid, email: "nope" }, { RESEND_API_KEY: "re_test" });
    expect(await bad.result).toMatchObject({ ok: false });
    expect(bot.waitUntil).not.toHaveBeenCalled();
    expect(bad.waitUntil).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.adminClient).not.toHaveBeenCalled();
  });
});
