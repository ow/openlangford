// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("~/lib/supabase.server", () => ({ createSupabaseServerClient: vi.fn(), getSupabaseAdminClient: vi.fn() }));
import AdminContact from "~/routes/admin-contact";

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("renders messages escaped with line breaks, reply links, civic times and email status", async () => {
  const loaderData = {
    filter: "all", openCount: 1,
    messages: [
      { id: "1", name: "<img src=x onerror=alert(1)>", email: "a@example.com", message: "First line\nSecond <b>line</b>", created_at: "2026-10-29T18:05:00Z", handled_at: null, notified_at: null },
      { id: "2", name: null, email: "b@example.com", message: "Done", created_at: "2026-10-28T18:05:00Z", handled_at: "2026-10-29T01:00:00Z", notified_at: "2026-10-28T18:06:00Z" },
    ],
  };
  const router = createMemoryRouter([{ path: "/admin/contact", element: h(AdminContact as any, { loaderData, actionData: undefined, params: {}, matches: [] }) }], { initialEntries: ["/admin/contact"] });
  await act(async () => root.render(h(RouterProvider, { router })));
  expect(host.querySelector("img")).toBeNull();
  expect(host.textContent).toContain("<img src=x onerror=alert(1)>");
  expect(host.querySelector("b")).toBeNull();
  const body = [...host.querySelectorAll("p")].find(p => p.textContent?.startsWith("First line"))!;
  expect(body.textContent).toBe("First line\nSecond <b>line</b>");
  expect(body.className).toContain("whitespace-pre-wrap");
  expect(host.querySelector('a[href^="mailto:a@example.com"]')?.getAttribute("href")).toBe("mailto:a@example.com?subject=Re%3A%20your%20message%20to%20Open%20Langford");
  expect(host.textContent).toContain("11:05");
  expect(host.textContent).toContain("Email not sent");
  expect(host.textContent).toContain("No name given");
  expect([...host.querySelectorAll("button")].map(b => b.textContent)).toEqual(["Mark handled", "Reopen"]);
  expect(host.textContent).toContain("Open(1)");
  expect(host.innerHTML).not.toContain("client_ip");
});
