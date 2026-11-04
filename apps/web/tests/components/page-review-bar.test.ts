// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PageReviewBar } from "~/components/admin/page-review-bar";
import type { PageFlag, PageReview } from "~/lib/page-review-types";

const PATH = "/matters/a-topic";
const flag = (key: string, reason: string): PageFlag => ({ key, problem: "different_story", reason, excerpt: reason, verdict: null });
const review = (flags: PageFlag[], checkedAt: string): PageReview => ({
  path: PATH, kind: "matters", title: "A topic", status: null, note: null, reviewed_at: null, ai_flags: flags,
  ai_page_issue: null, ai_summary: "A summary.", ai_entries: 3, ai_checked_at: checkedAt, agent_note: null, agent_at: null,
});

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
const buttons = (label: string) => [...host.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`)];
const byText = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);

it("doesn't carry a 👍 over to a different flag when Check again replaces the list", async () => {
  // The stored state the bar reads; ratings are saved straight to it, and Check again replaces the flags.
  let stored = review([flag("mention-1", "First old flag"), flag("mention-2", "Second old flag")], "2026-11-03T21:00:00Z");
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = init.body as FormData;
    const flags = [...stored.ai_flags!];
    flags[Number(body.get("index"))] = { ...flags[Number(body.get("index"))], verdict: body.get("verdict") as "agree" };
    stored = { ...stored, ai_flags: flags };
    return new Response("{}", { status: 200 });
  }));
  const router = createMemoryRouter([
    { path: "/matters/:slug", element: h(PageReviewBar) },
    {
      path: "/api/page-review",
      loader: () => ({ path: PATH, review: stored, links: null }),
      action: () => {
        // The new check flags other entries; nothing on them has been rated.
        stored = review([flag("mention-7", "New flag"), flag("mention-8", "Another new flag"), flag("mention-9", "Third")], "2026-11-03T21:05:00Z");
        return { ok: true, review: stored, links: null, message: null };
      },
    },
  ], { initialEntries: [PATH] });
  await act(async () => root.render(h(RouterProvider, { router })));
  await settle();

  await act(async () => buttons("Yes, fix it")[0].click());
  await settle();
  expect(buttons("Yes, fix it")[0].getAttribute("aria-pressed")).toBe("true");
  expect(byText("Fix 1")).toBeTruthy();

  await act(async () => byText("Check again")!.click());
  await settle();
  expect(host.textContent).toContain("New flag");
  // The server holds no rating for the new first flag, so the bar mustn't show one or offer to fix it.
  expect(buttons("Yes, fix it").map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "false", "false"]);
  expect(byText("Fix 1")).toBeUndefined();
  expect(byText("Needs work")).toBeTruthy();
});
