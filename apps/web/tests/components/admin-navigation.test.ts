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
  const router = createMemoryRouter([{ path: "/admin", element: h(Admin) }], { initialEntries: ["/admin"] });
  await act(async () => root.render(h(RouterProvider, { router, key: "directory" })));
  const matter = host.querySelector('a[href="/admin/matters"]');
  expect(matter?.textContent).toContain("Matter merge review");
  expect(host.querySelector('a[href="/admin/pipeline"]')?.textContent).toContain("Pipeline operations");
});
