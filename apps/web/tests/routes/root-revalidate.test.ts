import { expect, it } from "vitest";
import { shouldRevalidate } from "../../app/root";
import { serverTimingHeader, timed, withServerTiming } from "../../app/lib/server-timing.server";

const args = (from: string, to: string, extra: Record<string, unknown> = {}) => ({
  currentUrl: new URL(`https://openlangford.ca${from}`),
  nextUrl: new URL(`https://openlangford.ca${to}`),
  currentParams: {}, nextParams: {},
  defaultShouldRevalidate: true,
  ...extra,
}) as any;

it("skips the root loader on plain GET navigations between public pages", () => {
  for (const [from, to] of [["/", "/meetings"], ["/meetings", "/meetings?year=2024"], ["/people/mary-wagner", "/matters/x"], ["/matters?page=2", "/matters?page=3"]]) {
    expect(shouldRevalidate(args(from, to))).toBe(false);
  }
  // A GET form (search) is a navigation too.
  expect(shouldRevalidate(args("/", "/search?q=parks", { formMethod: "GET" }))).toBe(false);
});

it("re-runs the root loader after actions, on explicit revalidation and around the auth pages", () => {
  expect(shouldRevalidate(args("/login", "/", { formMethod: "POST" }))).toBe(true);
  expect(shouldRevalidate(args("/properties/x", "/properties/x", { formMethod: "post" }))).toBe(true);
  expect(shouldRevalidate(args("/meetings", "/meetings"))).toBe(true); // useRevalidator / same-URL reload
  for (const [from, to] of [["/", "/logout"], ["/meetings", "/login"], ["/onboarding", "/"], ["/settings", "/people"], ["/", "/settings/api-keys"], ["/", "/signup"]]) {
    expect(shouldRevalidate(args(from, to))).toBe(true);
  }
  // Defers to React Router's default where it would not revalidate (e.g. a 4xx action result).
  expect(shouldRevalidate(args("/login", "/login", { formMethod: "POST", defaultShouldRevalidate: false }))).toBe(false);
});

it("adds named loader steps to Server-Timing, and nothing when no step ran", async () => {
  const response = await withServerTiming(async () => {
    await Promise.all([timed("root-user", Promise.resolve(1)), timed("home data", async () => 2)]);
    return new Response("ok", { headers: { "Server-Timing": "cfEdge;dur=1" } });
  });
  const header = response.headers.get("Server-Timing")!;
  expect(header).toMatch(/^cfEdge;dur=1, root-user;dur=[\d.]+, home-data;dur=[\d.]+, app;dur=[\d.]+$/);
  expect(await response.text()).toBe("ok");
  const plain = await withServerTiming(async () => new Response("x"));
  expect(plain.headers.has("Server-Timing")).toBe(false);
  expect(await timed("outside", Promise.resolve(3))).toBe(3);
  expect(serverTimingHeader([{ name: "a b", dur: 1.234 }])).toBe("a-b;dur=1.2");
});
