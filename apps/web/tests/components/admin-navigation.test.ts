// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Navbar } from "~/components/navbar";
import Admin from "~/routes/admin";
vi.mock("~/components/search/quick-jump", () => ({ QuickJump: () => null }));
vi.mock("~/lib/supabase.server", () => ({ createSupabaseServerClient: vi.fn() }));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function renderNav(isAdmin: boolean) {
  const router = createMemoryRouter([{ id: "root", path: "/", loader: () => ({
    user: { id: "reader" }, isAdmin, signupsEnabled: false,
  }), element: h(Outlet), children: [{ index: true, element: h(Navbar) }] }]);
  await act(async () => root.render(h(RouterProvider, { router })));
  const toggle = host.querySelector('[aria-label="Toggle menu"]') as HTMLButtonElement;
  await act(async () => toggle.click());
  return [...host.querySelectorAll("a")];
}
it("does not advertise admin or speaker-editing tools to an ordinary signed-in user", async () => {
  const links = await renderNav(false);
  expect(links.some(link => link.getAttribute("href")?.startsWith("/admin"))).toBe(false);
  expect(links.some(link => link.getAttribute("href") === "/speaker-alias")).toBe(false);
  expect(links.some(link => link.getAttribute("href") === "/settings")).toBe(true);
});
it("shows a named admin entry on desktop and mobile, with matter review discoverable in the directory", async () => {
  const links = await renderNav(true);
  expect(links.filter(link => link.getAttribute("href") === "/admin")).toHaveLength(2);
  expect(links.filter(link => link.getAttribute("href") === "/admin").every(link => link.textContent?.includes("Admin"))).toBe(true);
  const days = Array.from({ length: 30 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, "0")}`, value: i % 3 }));
  const loaderData = {
    generatedAt: new Date().toISOString(),
    queues: { contact: { count: 1, oldest: "2026-10-26T00:00:00Z" }, names: 3, letters: { letters: 17, meetings: 10 }, merges: 2, profiles: 0, pages: 0, failedJobs: 2 },
    audience: { total: 8, signedIn7: 2, unconfirmed: 0, signups: days, followers: 5, alerts: 34, alertsAdded: days, alertTypes: [["topic", 25]], recent: [] },
    email: { sent7: 0, problems7: 0 },
    questions: days,
    askCost7: 0.04,
    calendar: { latest: null, upcoming: [] },
    traffic: { available: false, reason: "not_configured" },
  };
  const router = createMemoryRouter([{ path: "/admin", element: h(Admin as any, { loaderData } as any) }], { initialEntries: ["/admin"] });
  await act(async () => root.render(h(RouterProvider, { router, key: "directory" })));
  // Each tool says what's waiting in it.
  const matter = host.querySelector('a[href="/admin/matters"]');
  expect(matter?.textContent).toContain("Duplicate issues");
  expect(matter?.textContent).toContain("2 to review");
  expect(host.querySelector('a[href="/admin/pipeline"]')?.textContent).toContain("2 failed");
  expect(host.querySelector('a[href="/admin/profiles"]')?.textContent).toContain("Clear");
});
