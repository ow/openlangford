// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, Outlet, RouterProvider, useLoaderData } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickJump } from "~/components/search/quick-jump";
import SearchRoute from "~/routes/search";
import { askUrl, searchUrl, shouldAutoAsk } from "~/lib/search-ask";

vi.mock("~/lib/supabase.server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("~/lib/analytics", () => ({ trackEvent: vi.fn() }));

const QUESTION = "what was the most discussed topic this year?";
const HUMAN_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

describe("search-ask helpers", () => {
  it("builds an ask URL with mode=ai and a plain search URL without it", () => {
    expect(askUrl(QUESTION)).toBe(`/search?q=${encodeURIComponent(QUESTION).replace(/%20/g, "+")}&mode=ai`);
    expect(askUrl("housing", { person: "Jane Doe", other: undefined })).toBe("/search?q=housing&mode=ai&person=Jane+Doe");
    expect(searchUrl("bylaw 2299")).toBe("/search?q=bylaw+2299");
  });

  it("auto-asks only for explicit mode=ai, no cached answer, AI available, and a human visitor", () => {
    const base = { query: QUESTION, mode: "ai", cachedId: null, aiSearchAvailable: true, userAgent: HUMAN_UA };
    expect(shouldAutoAsk(base)).toBe(true);
    expect(shouldAutoAsk({ ...base, mode: null })).toBe(false);
    expect(shouldAutoAsk({ ...base, mode: "keyword" })).toBe(false);
    expect(shouldAutoAsk({ ...base, cachedId: "abc123" })).toBe(false);
    expect(shouldAutoAsk({ ...base, aiSearchAvailable: false })).toBe(false);
    expect(shouldAutoAsk({ ...base, query: " " })).toBe(false);
    expect(shouldAutoAsk({ ...base, userAgent: null })).toBe(false);
    expect(shouldAutoAsk({ ...base, userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" })).toBe(false);
  });
});

describe("Ask from the ⌘K palette", () => {
  let root: Root;
  let host: HTMLDivElement;
  let eventSources: string[];

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    eventSources = [];
    vi.stubGlobal("EventSource", class {
      onmessage: unknown = null;
      onerror: unknown = null;
      constructor(url: string) { eventSources.push(url); }
      close() {}
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
      ok: true,
      json: async () => (String(url).startsWith("/api/quick-search") ? { matches: [] } : { results: [] }),
    })));
    Object.defineProperty(window.navigator, "userAgent", { value: HUMAN_UA, configurable: true });
    // Radix Dialog needs these in jsdom.
    (globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  function SearchWithData() {
    const loaderData = useLoaderData() as any;
    return h(SearchRoute as any, { loaderData });
  }

  async function render(initialPath: string) {
    const router = createMemoryRouter(
      [{
        id: "root",
        path: "/",
        loader: () => ({ aiSearchAvailable: true, municipality: { short_name: "Langford" } }),
        element: h("div", null, h(QuickJump), h(Outlet)),
        children: [
          { index: true, element: h("p", null, "home") },
          {
            path: "search",
            loader: ({ request }: { request: Request }) => {
              const url = new URL(request.url);
              return { query: url.searchParams.get("q") || "", cachedId: null, intent: null, results: null, councilTerms: [] };
            },
            element: h(SearchWithData),
          },
        ],
      }],
      { initialEntries: [initialPath] },
    );
    await act(async () => root.render(h(RouterProvider, { router })));
    return router;
  }

  async function typeIntoPalette(text: string) {
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    });
    const input = document.querySelector('input[role="combobox"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function option(label: RegExp) {
    const el = [...document.querySelectorAll('[role="option"]')].find((o) => label.test(o.textContent || ""));
    expect(el).toBeTruthy();
    return el as HTMLElement;
  }

  it("goes straight to the AI answer for the question, with no second click", async () => {
    const router = await render("/");
    await typeIntoPalette(QUESTION);
    await act(async () => {
      option(/^Ask:/).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(router.state.location.pathname).toBe("/search");
    const params = new URLSearchParams(router.state.location.search);
    expect(params.get("q")).toBe(QUESTION);
    expect(params.get("mode")).toBe("ai");

    expect(eventSources).toHaveLength(1);
    const streamParams = new URLSearchParams(eventSources[0].split("?")[1]);
    expect(streamParams.get("q")).toBe(QUESTION);
    expect(streamParams.get("mode")).toBe("ai");
    expect(document.body.textContent).not.toContain("Looking for an explanation?");
  });

  it("keeps 'Search everything' as a plain records search", async () => {
    const router = await render("/");
    await typeIntoPalette(QUESTION);
    await act(async () => {
      option(/^Search everything/).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(router.state.location.pathname).toBe("/search");
    expect(new URLSearchParams(router.state.location.search).get("mode")).toBeNull();
    expect(eventSources).toHaveLength(0);
    expect(document.body.textContent).toContain("Looking for an explanation?");
  });

  it("does not start an AI answer for crawlers on a mode=ai URL", async () => {
    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      configurable: true,
    });
    await render(askUrl(QUESTION));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(eventSources).toHaveLength(0);
  });
});
