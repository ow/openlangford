// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMemoryRouter,
  RouterProvider,
  useLoaderData,
} from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Users from "~/routes/admin-users";
import User from "~/routes/admin-user";
import Emails from "~/routes/admin-emails";
import Email from "~/routes/admin-email";
import {
  usersFixture,
  userFixture,
  emailsFixture,
  emailFixture,
  sampleUserId,
  sampleEmailId,
} from "../fixtures/admin-audience";
vi.mock("~/lib/supabase.server", () => ({
  createSupabaseServerClient: vi.fn(),
  getSupabaseAdminClient: vi.fn(),
}));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
function page(Component: any) {
  return () => h(Component, { loaderData: useLoaderData() });
}
const routeFixtures = [
  { path: "/admin/users", loader: () => usersFixture, Component: page(Users) },
  {
    path: "/admin/users/:id",
    loader: () => userFixture,
    Component: page(User),
  },
  {
    path: "/admin/emails",
    loader: () => emailsFixture,
    Component: page(Emails),
  },
  {
    path: "/admin/emails/:id",
    loader: () => emailFixture,
    Component: page(Email),
  },
];
it("navigates from accounts to labelled subscriptions to email details without confusing accepted with delivered", async () => {
  const router = createMemoryRouter(routeFixtures, {
    initialEntries: ["/admin/users"],
  });
  await act(async () => root.render(h(RouterProvider, { router })));
  expect(host.textContent).toContain("Pending Reader");
  expect(host.textContent).toContain("No profile yet");
  await act(async () =>
    (
      host.querySelector(
        `a[href='/admin/users/${sampleUserId}']`,
      ) as HTMLAnchorElement
    ).click(),
  );
  expect(host.textContent).toContain("Community park plan");
  expect(host.textContent).toContain("1000 m radius");
  await act(async () =>
    (
      host.querySelector(
        `a[href='/admin/emails?user=${sampleUserId}']`,
      ) as HTMLAnchorElement
    ).click(),
  );
  expect(host.textContent).toContain(
    "Supabase Auth confirmation and password-reset emails are separate",
  );
  expect(host.textContent).toContain("accepted");
  await act(async () =>
    (
      host.querySelector(
        `a[href='/admin/emails/${sampleEmailId}']`,
      ) as HTMLAnchorElement
    ).click(),
  );
  expect(host.textContent).toContain("Safe plain-text preview");
  expect(host.querySelector("pre")?.textContent).toContain(
    "Council approved the community park plan",
  );
  const labels = [...host.querySelectorAll("dt")];
  expect(
    labels.find((label) => label.textContent === "Delivered")
      ?.nextElementSibling?.textContent,
  ).toBe("—");
});
it.each([false, true])(
  "explains email history coverage when schema availability is %s",
  async (available) => {
    const router = createMemoryRouter(
      [
        {
          path: "/admin/emails",
          loader: () => ({
            ...emailsFixture,
            available,
            messages: [],
            total: 0,
          }),
          Component: page(Emails),
        },
      ],
      { initialEntries: ["/admin/emails"] },
    );
    await act(async () => root.render(h(RouterProvider, { router })));
    expect(host.textContent).toContain(
      available
        ? "No recorded application emails match"
        : "ledger is not installed",
    );
    expect(host.textContent).not.toContain("No emails have been sent");
  },
);
