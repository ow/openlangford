import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { publicMeetingCache } from "../../workers/public-meeting-cache";
import { createSupabaseServerClient } from "../../app/lib/supabase.server";

const path = "/meetings/2026-10-05-regular-council";
const posthogKey = "phc_cachetestpublic";
const analyticsName = `ph_${posthogKey}_posthog`;
let entries: Map<string, { response: Response; expires: number }>;
let jobs: Promise<unknown>[];
const settle = async () => { while (jobs.length) await Promise.all(jobs.splice(0)); };
const ctx = { waitUntil: (job: Promise<unknown>) => jobs.push(job) };
const request = (suffix = "", init?: RequestInit) => new Request(`https://openlangford.ca${path}${suffix}`, {
  headers: { Accept: suffix.split("?")[0].endsWith(".data") ? "*/*" : "text/html" }, ...init,
});
const html = (body = "public meeting", init?: ResponseInit) => new Response(body, {
  headers: { "Content-Type": "text/html; charset=utf-8", "X-Record": "retained" }, ...init,
});
const serve = (req: Request, render: (request: Request) => Promise<Response>, version = "deploy-a") => publicMeetingCache(req, { deploy: version, stamp: "1", posthogKey }, ctx, render);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T15:30:00Z"));
  entries = new Map(); jobs = [];
  // Model the platform's expiry and response cloning, not the admission policy.
  vi.stubGlobal("caches", { default: {
    match: async (key: Request) => {
      const entry = entries.get(key.url);
      return entry && entry.expires > Date.now() ? entry.response.clone() : undefined;
    },
    put: async (key: Request, response: Response) => {
      const seconds = Number(/max-age=(\d+)/.exec(response.headers.get("cache-control") || "")?.[1]);
      entries.set(key.url, { response: new Response(await response.arrayBuffer(), response), expires: Date.now() + seconds * 1000 });
    },
  } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("reuses anonymous historical HTML, preserves content/status/headers, expires in six hours and invalidates on deploy", async () => {
  const render = vi.fn(async () => html());
  const first = await serve(request(), render); await settle();
  const hit = await serve(request(), render);
  expect(first.headers.get("X-Public-Meeting-Cache")).toBe("MISS");
  expect(hit.headers.get("X-Public-Meeting-Cache")).toBe("HIT");
  expect(await hit.text()).toBe("public meeting");
  expect(hit.status).toBe(200);
  expect(hit.headers.get("X-Record")).toBe("retained");
  expect(hit.headers.get("Cache-Control")).toBe("private, no-store");
  expect(render).toHaveBeenCalledTimes(1);
  await serve(request(), render, "deploy-b"); await settle();
  expect(render).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(6 * 3600_000 + 1);
  await serve(request(), render);
  expect(render).toHaveBeenCalledTimes(3);
});

it("keeps full and partial React Router navigation payloads, documents, and HTML separate", async () => {
  const variants = ["", ".data", ".data?_routes=routes%2Fmeeting-detail", ".data?_routes=root", ".data?_routes=root,routes%2Fmeeting-detail", "/documents", "/documents.data?_routes=routes%2Fmeeting-documents"];
  const render = vi.fn(async (suffix: string) => suffix.split("?")[0].endsWith(".data")
    ? new Response(`router-stream:${suffix}`, { headers: { "Content-Type": "text/x-script" } }) : html(`html:${suffix}`));
  for (const suffix of variants) { await serve(request(suffix), () => render(suffix)); await settle(); }
  for (const suffix of variants) {
    const hit = await serve(request(suffix), () => render(suffix));
    expect(hit.headers.get("X-Public-Meeting-Cache")).toBe("HIT");
    expect(await hit.text()).toBe(`${suffix.split("?")[0].endsWith(".data") ? "router-stream" : "html"}:${suffix}`);
  }
  expect(render).toHaveBeenCalledTimes(variants.length);
});

it("shares a response for the configured analytics cookie but renders with no cookies or Supabase user state", async () => {
  const cookie = `${analyticsName}=${encodeURIComponent(JSON.stringify({ distinct_id: "private-analytics-person", $sesid: [1, "private-session", 2] }))}`;
  const incoming = request(".data?_routes=root", { headers: { Accept: "*/*", Cookie: cookie } });
  const render = vi.fn(async (publicRequest: Request = incoming) => {
    expect(publicRequest.headers.has("cookie")).toBe(false);
    expect(publicRequest.url).toBe(`https://openlangford.ca${path}.data?_routes=root`);
    expect(publicRequest.headers.get("accept")).toBe("*/*");
    const { supabase } = createSupabaseServerClient(publicRequest);
    const { data: { user } } = await supabase.auth.getUser();
    return new Response(JSON.stringify({ user, isAdmin: !!user }), { headers: { "Content-Type": "text/x-script" } });
  });
  const first = await serve(incoming, render);
  expect(incoming.headers.get("cookie")).toBe(cookie);
  await settle();
  const hit = await serve(request(".data?_routes=root"), render);
  const otherVisitor = await serve(request(".data?_routes=root", { headers: { Accept: "*/*", Cookie: `${analyticsName}=another-person` } }), render);
  expect(first.headers.get("X-Public-Meeting-Cache")).toBe("MISS");
  expect(hit.headers.get("X-Public-Meeting-Cache")).toBe("HIT");
  expect(otherVisitor.headers.get("X-Public-Meeting-Cache")).toBe("HIT");
  for (const response of [first, hit, otherVisitor]) expect(await response.json()).toEqual({ user: null, isAdmin: false });
  expect(render).toHaveBeenCalledTimes(1);
});

it.each([
  "sb-project-auth-token=session",
  "sb-project-auth-token.0=chunk; sb-project-auth-token.1=chunk",
  "sb-project-auth-token-code-verifier=pkce",
  "unknown=personalized", "cookieconsent=accepted", "ph_anotherproject_posthog=person",
  `${analyticsName}_extra=person`, `${analyticsName}%3Bsb-project-auth-token=person`,
  "malformed", "", // malformed/empty cookie headers also fail closed
])("does not let valid analytics hide a session/unknown cookie: %s", async (otherCookie) => {
  await serve(request(), async () => html("cached anonymous")); await settle();
  const cookie = `${analyticsName}=analytics; ${otherCookie}`;
  const render = vi.fn(async (original: Request) => {
    expect(original.headers.get("cookie")).toBe(cookie.trim());
    return html("original session response");
  });
  const response = await serve(request("", { headers: { Accept: "text/html", Cookie: cookie } }), render);
  expect(await response.text()).toBe("original session response");
  expect(response.headers.has("X-Public-Meeting-Cache")).toBe(false);
  expect(render).toHaveBeenCalledTimes(1); expect(entries.size).toBe(1);
});

it("bypasses known analytics without configuration or with authorization", async () => {
  for (const { headers, key } of [
    { headers: { Cookie: `${analyticsName}=person`, Authorization: "Bearer session" }, key: posthogKey },
    { headers: { Cookie: `${analyticsName}=person` }, key: undefined },
  ]) {
    const render = vi.fn(async (original: Request) => html(original.headers.get("cookie")!));
    const response = await publicMeetingCache(request("", { headers: { Accept: "text/html", ...headers } }), { deploy: "deploy-a", stamp: "1", posthogKey: key }, ctx, render);
    expect(await response.text()).toBe(`${analyticsName}=person`);
    expect(response.headers.has("X-Public-Meeting-Cache")).toBe(false);
  }
  expect(entries.size).toBe(0);
});

it.each([
  { Cookie: "sb-session=signed-in" }, { Cookie: "analytics=anonymous" },
  { Authorization: "Bearer session" }, { Range: "bytes=0-9" },
  { "If-None-Match": "etag" }, { "If-Modified-Since": "Mon, 05 Oct 2026 00:00:00 GMT" },
  { "Cache-Control": "no-cache" }, { Pragma: "no-cache" },
] as Record<string, string>[])("never reads or writes shared content for request headers %j", async (headers) => {
  await serve(request(), async () => html()); await settle();
  const render = vi.fn(async () => html("session-specific"));
  const response = await serve(request("", { headers: { Accept: "text/html", ...headers } }), render);
  expect(await response.text()).toBe("session-specific");
  expect(render).toHaveBeenCalledTimes(1);
  expect(entries.size).toBe(1);
});

it.each([
  ["/admin/pipeline", "GET"], ["/meetings?year=2020", "GET"], ["/meetings/42", "GET"],
  ["/meetings/2026-10-20-regular-council", "GET"], ["/meetings/2026-02-30-regular-council", "GET"],
  [path, "POST"], [path, "HEAD"], [path + "?q=unsafe", "GET"],
  [path + ".data?_routes=routes/admin-pipeline", "GET"],
  [path + ".data?_routes=root&_routes=routes/meeting-detail", "GET"],
  [path + ".data?_routes=", "GET"], [path + ".data?extra=unsafe", "GET"],
  [path + "/documents.data?_routes=routes/meeting-detail", "GET"],
  [path + "/summary.md", "GET"], [path + "/documents/12/content.md", "GET"],
])("bypasses unsupported route/query/method %s %s", async (pathname, method) => {
  const isData = pathname.split("?")[0].endsWith(".data");
  await serve(new Request(`https://openlangford.ca${pathname}`, { method, headers: { Accept: isData ? "*/*" : "text/html" } }), async () =>
    new Response("origin response", { headers: { "Content-Type": isData ? "text/x-script" : "text/html" } }));
  await settle(); expect(entries.size).toBe(0);
});

it.each(["text/markdown", "text/html, text/markdown", "application/json"])("preserves content negotiation for %s", async (accept) => {
  await serve(request(), async () => html()); await settle();
  const negotiated = await serve(request("", { headers: { Accept: accept } }), async () => new Response("negotiated content"));
  expect(await negotiated.text()).toBe("negotiated content");
});

it.each([
  { status: 500 }, { status: 404 }, { status: 302, headers: { Location: "/login" } },
  { headers: { "Set-Cookie": "session=renewed" } }, { headers: { "Cache-Control": "private" } },
  { headers: { "Cache-Control": "no-store" } }, { headers: { "Cache-Control": "max-age=0" } },
  { headers: { Vary: "Cookie" } },
  { headers: { "Content-Type": "application/json" } },
] as ResponseInit[])("never caches errors, redirects or responses with unsafe headers %j", async (init) => {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "text/html");
  const render = vi.fn(async () => new Response("origin response", { ...init, headers }));
  const response = await serve(request("", { headers: { Accept: "text/html", Cookie: `${analyticsName}=person` } }), render); await settle();
  expect(response.status).toBe(init.status || 200);
  for (const [name, value] of headers) expect(response.headers.get(name)).toBe(value);
  await serve(request(), render);
  expect(render).toHaveBeenCalledTimes(2); expect(entries.size).toBe(0);
});

it("fails open when cache reads/writes fail and bypasses missing version metadata", async () => {
  vi.stubGlobal("caches", { default: { match: async () => { throw Error("unavailable"); }, put: async () => { throw Error("unavailable"); } } });
  expect(await (await serve(request(), async () => html())).text()).toBe("public meeting");
  await settle();
  const response = await publicMeetingCache(request(), {}, ctx, async () => html("uncached"));
  expect(await response.text()).toBe("uncached");
  expect(response.headers.has("X-Public-Meeting-Cache")).toBe(false);
});

it("keeps historical route-only meeting/document navigation warm for 24h while root-inclusive representations stay at six hours", async () => {
  const archive = "/meetings/2016-01-01-regular-council";
  const urls = [".data?_routes=routes%2Fmeeting-detail", "/documents.data?_routes=routes%2Fmeeting-documents", "/documents/42.data?_routes=routes%2Fdocument-viewer", ".data", ".data?_routes=root,routes%2Fmeeting-detail", ""];
  const render = vi.fn(async (req: Request) => new URL(req.url).pathname.endsWith(".data") ? new Response("stream", { headers: { "Content-Type": "text/x-script" } }) : html());
  const req = (suffix: string) => new Request(`https://openlangford.ca${archive}${suffix}`, { headers: { Accept: suffix === "" ? "text/html" : "*/*" } });
  for (const suffix of urls) { await serve(req(suffix), render); await settle(); }
  expect(render).toHaveBeenCalledTimes(6);
  vi.advanceTimersByTime(6 * 3600_000 + 1);
  for (const [index, suffix] of urls.entries()) expect((await serve(req(suffix), render)).headers.get("X-Public-Meeting-Cache")).toBe(index < 3 ? "HIT" : "STALE");
  expect(render).toHaveBeenCalledTimes(9); await settle();
  await serve(req(urls[0]), render, "deploy-b:corrected"); expect(render).toHaveBeenCalledTimes(10);
  vi.advanceTimersByTime(86400_000); await serve(req(urls[0]), render); expect(render).toHaveBeenCalledTimes(11);
});

it("caches anonymous public detail pages for six hours and keeps their navigation payloads to their own route", async () => {
  const at = (p: string, init?: RequestInit) => new Request(`https://openlangford.ca${p}`, { headers: { Accept: p.split("?")[0].endsWith(".data") ? "*/*" : "text/html" }, ...init });
  for (const page of ["/matters/953-walfred-road-rezoning", "/bylaws/bylaw-2275", "/properties/2140-caribou-drive", "/people/scott-goodmanson", "/people/scott-goodmanson/votes", "/elections/2022"]) {
    const render = vi.fn(async () => html(`page:${page}`));
    await serve(at(page), render); await settle();
    const hit = await serve(at(page), render);
    expect(hit.headers.get("X-Public-Meeting-Cache")).toBe("HIT");
    expect(await hit.text()).toBe(`page:${page}`);
    // Filters, other routes' loaders and signed-in visitors always render.
    expect((await serve(at(`${page}?timeRange=12m`), render)).headers.get("X-Public-Meeting-Cache")).toBeNull();
    expect((await serve(at(`${page}.data?_routes=routes/meeting-detail`), render)).headers.get("X-Public-Meeting-Cache")).toBeNull();
    expect((await serve(at(page, { headers: { Accept: "text/html", Cookie: "sb-ref-auth-token=session" } }), render)).headers.get("X-Public-Meeting-Cache")).toBeNull();
    expect(render).toHaveBeenCalledTimes(4);
  }
  for (const page of ["/admin/matters", "/settings", "/admin", "/login", "/onboarding"]) {
    expect((await serve(at(page), async () => html())).headers.get("X-Public-Meeting-Cache")).toBeNull();
  }
  const render = vi.fn(async () => html());
  await serve(at("/matters/x"), render); await settle();
  vi.advanceTimersByTime(6 * 3600_000 + 1);
  await serve(at("/matters/x"), render);
  expect(render).toHaveBeenCalledTimes(2);
});

const session = "sb-zxcvifwkaxtdfpanlwtl-auth-token=base64-session";
const dataAt = (p: string, cookie?: string) => new Request(`https://openlangford.ca${p}`, { headers: { Accept: "*/*", ...(cookie ? { Cookie: cookie } : {}) } });
const stream = (body: string) => new Response(body, { headers: { "Content-Type": "text/x-script" } });

it("serves route-only navigation data to signed-in visitors, rendered without their cookies, sharing the anonymous entry", async () => {
  const urls = ["/people/mary-wagner.data?_routes=routes%2Fperson-profile", "/meetings.data?_routes=routes%2Fmeetings", "/_root.data?_routes=routes%2Fhome",
    "/matters.data?_routes=routes%2Fmatters", "/properties/2140-caribou-drive.data?_routes=routes%2Fproperty-detail", `${path}.data?_routes=routes%2Fmeeting-detail`];
  for (const url of urls) {
    const render = vi.fn(async (req: Request) => { expect(req.headers.has("cookie")).toBe(false); return stream(`data:${url}`); });
    const first = await serve(dataAt(url, `${session}; ${analyticsName}=person`), render); await settle();
    expect(first.headers.get("X-Public-Meeting-Cache")).toBe("MISS");
    for (const cookie of [undefined, session, `${session.replace("=", ".0=")}; ${session.replace("=", ".1=")}`]) {
      const hit = await serve(dataAt(url, cookie), render);
      expect(hit.headers.get("X-Public-Meeting-Cache")).toBe("HIT"); expect(await hit.text()).toBe(`data:${url}`);
      expect(hit.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(render).toHaveBeenCalledTimes(1);
  }
});

it("keeps HTML and root-inclusive payloads anonymous-only, and other cookies fail closed", async () => {
  const signedIn = [
    new Request("https://openlangford.ca/people/mary-wagner", { headers: { Accept: "text/html", Cookie: session } }),
    new Request("https://openlangford.ca/meetings", { headers: { Accept: "text/html", Cookie: session } }),
    dataAt("/people/mary-wagner.data", session),
    dataAt("/people/mary-wagner.data?_routes=root,routes%2Fperson-profile", session),
    dataAt("/people/mary-wagner.data?_routes=root", session),
    dataAt(`${path}.data?_routes=root,routes%2Fmeeting-detail`, session),
    // Route-only, but another cookie (the onboarding flash, a PKCE verifier, anything unknown).
    dataAt("/_root.data?_routes=routes%2Fhome", `${session}; onboarding_notice=complete`),
    dataAt("/people/mary-wagner.data?_routes=routes%2Fperson-profile", `${session}; sb-zxcvifwkaxtdfpanlwtl-auth-token-code-verifier=x`),
    dataAt("/people/mary-wagner.data?_routes=routes%2Fperson-profile", `${session}; theme=dark`),
    // Route-only but not a cached route.
    dataAt("/settings.data?_routes=routes%2Fsettings", session),
    dataAt("/admin/matters.data?_routes=routes%2Fadmin-matters", session),
  ];
  for (const req of signedIn) {
    const anonymous = new Request(req.url, { headers: { Accept: req.headers.get("accept")! } });
    await serve(anonymous, async () => req.headers.get("accept") === "text/html" ? html("anon") : stream("anon")); await settle();
    const render = vi.fn(async (original: Request) => {
      expect(original.headers.get("cookie")).toBe(req.headers.get("cookie"));
      return req.headers.get("accept") === "text/html" ? html("personal") : stream("personal");
    });
    const response = await serve(req, render);
    expect(response.headers.has("X-Public-Meeting-Cache")).toBe(false);
    expect(await response.text()).toBe("personal");
    expect(render).toHaveBeenCalledTimes(1);
  }
});

it("caches index pages (and the home page's /_root.data) for five minutes, without query strings", async () => {
  for (const page of ["/", "/meetings", "/matters", "/people", "/participants", "/bylaws", "/properties"]) {
    const render = vi.fn(async () => html(`index:${page}`));
    await serve(new Request(`https://openlangford.ca${page}`, { headers: { Accept: "text/html" } }), render); await settle();
    expect((await serve(new Request(`https://openlangford.ca${page}`, { headers: { Accept: "text/html" } }), render)).headers.get("X-Public-Meeting-Cache")).toBe("HIT");
    expect((await serve(new Request(`https://openlangford.ca${page}?page=2`, { headers: { Accept: "text/html" } }), render)).headers.get("X-Public-Meeting-Cache")).toBeNull();
    vi.advanceTimersByTime(300_001);
    expect((await serve(new Request(`https://openlangford.ca${page}`, { headers: { Accept: "text/html" } }), render)).headers.get("X-Public-Meeting-Cache")).toBe("STALE");
    await settle();
  }
  // /_root.data only serves the home route.
  expect((await serve(dataAt("/_root.data?_routes=routes%2Fmeetings"), async () => stream("x"))).headers.get("X-Public-Meeting-Cache")).toBeNull();
});

it("serves stale pages while re-rendering in the background when the content stamp moves, never across deployments", async () => {
  const at = (cookie?: string) => dataAt("/people/mary-wagner.data?_routes=routes%2Fperson-profile", cookie);
  const withStamp = (req: Request, stamp: string, render: (r: Request) => Promise<Response>, deploy = "deploy-a") =>
    publicMeetingCache(req, { deploy, stamp, posthogKey }, ctx, render);
  const render = vi.fn(async () => stream("v1"));
  await withStamp(at(), "1000", render); await settle();
  let release!: () => void;
  render.mockImplementation(() => new Promise<Response>((resolve) => { release = () => resolve(stream("v2")); }));
  // A newer stamp: the signed-in visitor gets the previous payload at once; one background render.
  const stale = await withStamp(at(session), "2000", render);
  expect(stale.headers.get("X-Public-Meeting-Cache")).toBe("STALE"); expect(await stale.text()).toBe("v1");
  expect(stale.headers.has("X-Content-Stamp")).toBe(false);
  const again = await withStamp(at(), "2000", render);
  expect(again.headers.get("X-Public-Meeting-Cache")).toBe("STALE");
  expect(render).toHaveBeenCalledTimes(2); release(); await settle();
  render.mockImplementation(async () => stream("v2"));
  const fresh = await withStamp(at(), "2000", render);
  expect(fresh.headers.get("X-Public-Meeting-Cache")).toBe("HIT"); expect(await fresh.text()).toBe("v2");
  // Another deployment never sees the old deployment's entries.
  expect((await withStamp(at(), "2000", render, "deploy-b")).headers.get("X-Public-Meeting-Cache")).toBe("MISS");
  // Over a day old: rendered inline.
  vi.advanceTimersByTime(86400_000 + 1);
  expect((await withStamp(at(), "3000", render)).headers.get("X-Public-Meeting-Cache")).toBe("MISS");
});

it("never caches without a content stamp", async () => {
  const render = vi.fn(async () => html());
  await publicMeetingCache(request(), { deploy: "deploy-a", posthogKey }, ctx, render); await settle();
  await publicMeetingCache(request(), { deploy: "deploy-a", posthogKey }, ctx, render);
  expect(render).toHaveBeenCalledTimes(2); expect(entries.size).toBe(0);
});
