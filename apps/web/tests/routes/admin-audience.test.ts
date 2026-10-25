import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStaticHandler } from "react-router";
import routes from "~/routes";
import * as users from "~/routes/admin-users";
import * as user from "~/routes/admin-user";
import * as emails from "~/routes/admin-emails";
import * as email from "~/routes/admin-email";

const mocks = vi.hoisted(() => ({
  currentUser: vi.fn(),
  admin: vi.fn(),
  listUsers: vi.fn(),
  getUserById: vi.fn(),
  from: vi.fn(),
}));
vi.mock("~/lib/supabase.server", () => ({
  createSupabaseServerClient: () => ({
    supabase: { auth: { getUser: mocks.currentUser } },
    headers: new Headers(),
  }),
  getSupabaseAdminClient: mocks.admin,
}));
const id = "11111111-1111-4111-8111-111111111111",
  messageId = "22222222-2222-4222-8222-222222222222";
const modules: Record<string, any> = {
  "routes/admin-users.tsx": users,
  "routes/admin-user.tsx": user,
  "routes/admin-emails.tsx": emails,
  "routes/admin-email.tsx": email,
};
const handler = createStaticHandler(
  routes
    .filter((route) => modules[route.file])
    .map((route) => ({
      id: route.file,
      path: route.path,
      loader: modules[route.file].loader,
      action: modules[route.file].action,
    })),
);
const endpoints = [
  ["/admin/users", "routes/admin-users.tsx"],
  [`/admin/users/${id}`, "routes/admin-user.tsx"],
  ["/admin/emails", "routes/admin-emails.tsx"],
  [`/admin/emails/${messageId}`, "routes/admin-email.tsx"],
];

function query(result: any) {
  const chain: any = {
    then: (resolve: any) => Promise.resolve(result).then(resolve),
  };
  for (const method of [
    "select",
    "eq",
    "in",
    "order",
    "range",
    "maybeSingle",
    "ilike",
    "gte",
    "lt",
  ])
    chain[method] = vi.fn(() => chain);
  return chain;
}
const account = {
  id,
  email: "pending@example.test",
  created_at: "2026-10-25T00:00:00Z",
  user_metadata: {
    display_name: "Pending Reader",
    secret: "never-serialize-metadata",
  },
  identities: [{ secret: "never-serialize-identity" }],
};
function adminSession() {
  mocks.currentUser.mockResolvedValue({
    data: { user: { id, email: "ADMIN@example.test" } },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ADMIN_EMAILS", "admin@example.test");
  vi.stubEnv("ADMIN_EMAIL", "");
  adminSession();
  mocks.admin.mockReturnValue({
    auth: {
      admin: { listUsers: mocks.listUsers, getUserById: mocks.getUserById },
    },
    from: mocks.from,
  });
  mocks.listUsers.mockResolvedValue({
    data: { users: [account], total: 1, nextPage: null },
    error: null,
  });
  mocks.getUserById.mockResolvedValue({ data: { user: account }, error: null });
  mocks.from.mockImplementation((table: string) =>
    query({ data: table === "user_profiles" ? [] : [], count: 0, error: null }),
  );
});
afterEach(() => vi.unstubAllEnvs());

it.each(endpoints)(
  "rejects anonymous GET/POST and direct data loading at %s before touching privileged services",
  async (path, routeId) => {
    mocks.currentUser.mockResolvedValue({ data: { user: null } });
    for (const method of ["GET", "POST"]) {
      const request = new Request(`https://example.test${path}`, { method });
      const response = (await handler.query(request)) as Response;
      expect(response.status).toBe(302);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("Location")).toContain("/login?redirectTo=");
    }
    const direct = (await handler.queryRoute(
      new Request(`https://example.test${path}`),
      { routeId },
    )) as Response;
    expect(direct.status).toBe(302);
    expect(direct.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.admin).not.toHaveBeenCalled();
  },
);

it.each(endpoints)(
  "rejects direct data loading by an ordinary account at %s, even with forged admin metadata",
  async (path, routeId) => {
    mocks.currentUser.mockResolvedValue({
      data: {
        user: {
          id,
          email: "reader@example.test",
          user_metadata: { role: "admin" },
        },
      },
    });
    await expect(
      handler.queryRoute(new Request(`https://example.test${path}`), {
        routeId,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(mocks.admin).not.toHaveBeenCalled();
  },
);

it("lists a pending Auth account without a profile, with bounded queries and only approved account fields", async () => {
  const context: any = await handler.query(
    new Request("https://example.test/admin/users"),
  );
  const data = context.loaderData["routes/admin-users.tsx"];
  expect(data.users).toMatchObject([
    {
      id,
      email: account.email,
      name: "Pending Reader",
      hasProfile: false,
      confirmedAt: null,
      subscriptionCount: 0,
    },
  ]);
  expect(JSON.stringify(data)).not.toMatch(
    /never-serialize|identities|user_metadata/,
  );
  expect(mocks.listUsers).toHaveBeenCalledWith({ page: 1, perPage: 25 });
  expect(
    context.loaderHeaders["routes/admin-users.tsx"].get("Cache-Control"),
  ).toBe("private, no-store");
  expect(context.loaderHeaders["routes/admin-users.tsx"].get("Vary")).toBe(
    "Cookie",
  );
});

it("returns only the requested user's labelled subscriptions and minimal preferences", async () => {
  const profile = query({
    data: {
      display_name: "Reader",
      notification_email: "alerts@example.test",
      neighborhood: "Downtown",
      digest_enabled: false,
      digest_frequency: "weekly",
      address: "private-street",
    },
    error: null,
  });
  const subscriptions = query({
    data: [
      {
        id: 1,
        type: "matter",
        matter: { title: "Park plan" },
        created_at: "2026-10-25T00:00:00Z",
      },
    ],
    count: 26,
    error: null,
  });
  mocks.from.mockImplementation((table) =>
    table === "user_profiles" ? profile : subscriptions,
  );
  const context: any = await handler.query(
    new Request(`https://example.test/admin/users/${id}`),
  );
  const data = context.loaderData["routes/admin-user.tsx"];
  expect(data.subscriptions).toMatchObject([
    { label: "Park plan", type: "matter" },
  ]);
  expect(data.hasMore).toBe(true);
  expect(subscriptions.eq).toHaveBeenCalledWith("user_id", id);
  expect(subscriptions.range).toHaveBeenCalledWith(0, 24);
  expect(JSON.stringify(data)).not.toContain("private-street");
  expect(
    context.loaderHeaders["routes/admin-user.tsx"].get("Cache-Control"),
  ).toBe("private, no-store");
});

it.each([
  "/admin/users/not-a-uuid",
  "/admin/emails/not-a-uuid",
  "/admin/emails?user=another-user",
  "/admin/users?page=10001",
  "/admin/emails?status=made-up",
  "/admin/emails?from=2026-99-99",
])("rejects invalid input before privileged queries: %s", async (path) => {
  const context: any = await handler.query(
    new Request(`https://example.test${path}`),
  );
  expect(context.statusCode).toBe(400);
  expect(mocks.admin).not.toHaveBeenCalled();
  expect(
    Object.values(context.loaderHeaders).some(
      (header: any) => header.get("Cache-Control") === "private, no-store",
    ),
  ).toBe(true);
});

it("returns private 404 for an unknown account instead of returning an unrelated profile", async () => {
  mocks.getUserById.mockResolvedValue({
    data: { user: null },
    error: { status: 404, code: "user_not_found" },
  });
  const context: any = await handler.query(
    new Request(`https://example.test/admin/users/${id}`),
  );
  expect(context.statusCode).toBe(404);
  expect(mocks.from).not.toHaveBeenCalled();
  expect(
    context.loaderHeaders["routes/admin-user.tsx"].get("Cache-Control"),
  ).toBe("private, no-store");
});

it("distinguishes missing ledger, installed empty ledger and backend failures without leaking provider errors", async () => {
  for (const [error, expected, available] of [
    [{ code: "PGRST205" }, 200, false],
    [null, 200, true],
    [{ code: "42501", message: "private-token-error" }, 503, null],
  ] as const) {
    mocks.from.mockReturnValue(query({ data: [], count: 0, error }));
    const context: any = await handler.query(
      new Request("https://example.test/admin/emails"),
    );
    expect(context.statusCode).toBe(expected);
    expect(
      context.loaderHeaders["routes/admin-emails.tsx"].get("Cache-Control"),
    ).toBe("private, no-store");
    if (available !== null)
      expect(context.loaderData["routes/admin-emails.tsx"]).toMatchObject({
        available,
        messages: [],
      });
    expect(JSON.stringify(context.loaderData)).not.toContain(
      "private-token-error",
    );
  }
});

it("bounds ledger filters and excludes preview bodies from list data", async () => {
  const chain = query({ data: [], count: 30, error: null });
  mocks.from.mockReturnValue(chain);
  const context: any = await handler.query(
    new Request(
      `https://example.test/admin/emails?page=2&user=${id}&q=a%25_b&status=accepted&type=meeting_digest&from=2026-10-01&to=2026-10-25`,
    ),
  );
  expect(context.loaderData["routes/admin-emails.tsx"].hasMore).toBe(false);
  expect(chain.eq).toHaveBeenCalledWith("user_id", id);
  expect(chain.eq).toHaveBeenCalledWith("status", "accepted");
  expect(chain.ilike).toHaveBeenCalledWith("recipient", "%a\\%\\_b%");
  expect(chain.range).toHaveBeenCalledWith(25, 49);
  expect(chain.select.mock.calls[0][0]).not.toContain("preview_text");
  expect(chain.lt).toHaveBeenCalledWith(
    "created_at",
    "2026-10-26T00:00:00.000Z",
  );
});

it.each([
  "Your PIN is 1234",
  "Your one-time passcode is 54321",
  "Reset code 123456 https://example.test/auth/confirm?token=secret",
  '<img src="https://tracker.test/pixel">',
  "Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890",
])(
  "withholds unsafe email content before any loader serialization",
  async (unsafe) => {
    const message = query({
      data: {
        id: messageId,
        recipient: "reader@example.test",
        subject: "Council update",
        message_type: "meeting_digest",
        status: "accepted",
        preview_text: unsafe,
        last_error: "Bearer secret-token-value password hunter2 token abc123",
        provider_message_id:
          "https://example.test/reset?token=secret-provider-token",
      },
      error: null,
    });
    const events = query({ data: [], count: 0, error: null });
    mocks.from.mockImplementation((table) =>
      table === "email_messages" ? message : events,
    );
    const context: any = await handler.query(
      new Request(`https://example.test/admin/emails/${messageId}`),
    );
    const data = context.loaderData["routes/admin-email.tsx"];
    expect(data.message.preview).toBeNull();
    expect(JSON.stringify(data)).not.toContain(unsafe);
    expect(JSON.stringify(data)).not.toContain("secret-token-value");
    expect(JSON.stringify(data)).not.toContain("hunter2");
    expect(JSON.stringify(data)).not.toContain("abc123");
    expect(JSON.stringify(data)).not.toContain("secret-provider-token");
    expect(data.message.status).toBe("accepted");
    expect(
      context.loaderHeaders["routes/admin-email.tsx"].get("Cache-Control"),
    ).toBe("private, no-store");
  },
);

it("returns a safe preview and only events scoped to the requested message", async () => {
  const message = query({
    data: {
      id: messageId,
      recipient: "reader@example.test",
      subject: "Council update",
      message_type: "meeting_digest",
      status: "accepted",
      preview_text: "Council approved the park plan.",
    },
    error: null,
  });
  const events = query({
    data: [
      {
        id,
        event_type: "accepted",
        attempt_number: 1,
        occurred_at: "2026-10-25T00:00:00Z",
        raw_payload: "never-return",
      },
    ],
    count: 1,
    error: null,
  });
  mocks.from.mockImplementation((table) =>
    table === "email_messages" ? message : events,
  );
  const context: any = await handler.query(
    new Request(`https://example.test/admin/emails/${messageId}`),
  );
  const data = context.loaderData["routes/admin-email.tsx"];
  expect(data.message.preview).toBe("Council approved the park plan.");
  expect(events.eq).toHaveBeenCalledWith("message_id", messageId);
  expect(events.range).toHaveBeenCalledWith(0, 24);
  expect(JSON.stringify(data)).not.toContain("never-return");
});

it.each(endpoints)(
  "keeps explicitly allowlisted admin POSTs read-only at %s",
  async (path) => {
    const context: any = await handler.query(
      new Request(`https://example.test${path}`, { method: "POST" }),
    );
    expect(context.statusCode).toBe(405);
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(
      Object.values(context.actionHeaders).some(
        (header: any) => header.get("Cache-Control") === "private, no-store",
      ),
    ).toBe(true);
  },
);
