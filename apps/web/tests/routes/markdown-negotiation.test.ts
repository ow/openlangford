import { describe, expect, it, vi } from "vitest";
import { htmlToMarkdown, markdownRoute, negotiateMarkdown, prefersMarkdown } from "../../workers/markdown-negotiation";

const PAGE = `<!doctype html><html><head><title>Matters | Open Langford</title>
<meta name="description" content="Council matters"><meta property="og:image" content="https://openlangford.ca/og.png">
<link rel="canonical" href="https://openlangford.ca/matters"><script>window.x=1</script></head>
<body><nav><a href="/">Home</a></nav><main><h1>Matters</h1><p>See <a href="/matters/12">Bylaw 2100</a>.</p>
<button>Filter</button><ul><li>One</li><li>Two</li></ul><svg><text>icon</text></svg></main><footer>Footer</footer></body></html>`;

const req = (path: string, accept?: string, method = "GET") =>
  new Request(`https://openlangford.ca${path}`, { method, headers: accept ? { accept } : {} });
const html = (body = PAGE, init: ResponseInit = {}) =>
  new Response(body, { status: 200, ...init, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", ...(init.headers || {}) } });

it("robots.txt declares the same content signals as Markdown responses", async () => {
  const { readFileSync } = await import("node:fs");
  const { CONTENT_SIGNAL } = await import("../../workers/markdown-negotiation");
  expect(readFileSync("public/robots.txt", "utf8")).toMatch(new RegExp(`User-agent: \\*\\nContent-Signal: ${CONTENT_SIGNAL}\\n`));
});

describe("prefersMarkdown", () => {
  it.each([
    ["text/markdown", true],
    ["text/markdown, text/html;q=0.9", true],
    ["text/html, text/markdown", true],
    ["text/html, text/markdown;q=0.5", false],
    ["text/markdown;q=0", false],
    ["text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", false],
    ["", false],
  ])("%s -> %s", (accept, expected) => {
    expect(prefersMarkdown(req("/", accept))).toBe(expected);
  });
});

describe("markdownRoute", () => {
  it("maps meeting and document pages to their dedicated Markdown", () => {
    expect(markdownRoute("/meetings/2026-10-20-regular-council")).toBe("/meetings/2026-10-20-regular-council/summary.md");
    expect(markdownRoute("/meetings/2026-10-20-regular-council/documents/42")).toBe("/meetings/2026-10-20-regular-council/documents/42/content.md");
    expect(markdownRoute("/meetings")).toBeNull();
    expect(markdownRoute("/meetings/2026-10-20-regular-council/explorer")).toBeNull();
    expect(markdownRoute("/matters/12")).toBeNull();
  });
});

describe("htmlToMarkdown", () => {
  it("keeps main content with frontmatter and absolute links, dropping chrome and scripts", () => {
    const md = htmlToMarkdown(PAGE, "https://openlangford.ca/matters");
    expect(md).toMatch(/^---\ntitle: "Matters \| Open Langford"\ndescription: "Council matters"\nimage: "https:\/\/openlangford.ca\/og.png"\nurl: "https:\/\/openlangford.ca\/matters"\n---\n/);
    expect(md).toContain("# Matters");
    expect(md).toContain("[Bylaw 2100](https://openlangford.ca/matters/12)");
    expect(md).toContain("- One");
    for (const absent of ["Home", "Footer", "Filter", "window.x", "icon"]) expect(md).not.toContain(absent);
  });
});

describe("negotiateMarkdown", () => {
  it("leaves browsers on HTML and adds Vary: Accept", async () => {
    const render = vi.fn(async () => html());
    const res = await negotiateMarkdown(req("/matters", "text/html,*/*;q=0.8"), render);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("vary")).toBe("Accept");
    expect(await res.text()).toBe(PAGE);
  });

  it("converts an HTML page for Accept: text/markdown, rendering it as an HTML navigation", async () => {
    const render = vi.fn(async (_: Request) => html(PAGE, { headers: { vary: "Accept-Encoding", etag: "x" } }));
    const res = await negotiateMarkdown(req("/matters", "text/markdown"), render);
    expect(render.mock.calls[0][0].headers.get("accept")).toBe("text/html");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("vary")).toBe("Accept-Encoding, Accept");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.has("etag")).toBe(false);
    expect(res.headers.get("content-signal")).toBe("ai-train=no, search=yes, ai-input=yes");
    const body = await res.text();
    expect(Number(res.headers.get("x-markdown-tokens"))).toBe(Math.ceil(body.length / 4));
    expect(body).toContain("# Matters");
  });

  it("serves the dedicated meeting Markdown when it exists", async () => {
    const render = vi.fn(async (r: Request) => new URL(r.url).pathname.endsWith("/summary.md")
      ? new Response("# Regular Council\n", { headers: { "content-type": "text/markdown; charset=utf-8" } })
      : html());
    const res = await negotiateMarkdown(req("/meetings/2026-10-20-regular-council", "text/markdown"), render);
    expect(render).toHaveBeenCalledTimes(1);
    expect(await res.text()).toBe("# Regular Council\n");
    expect(res.headers.get("vary")).toBe("Accept");
    expect(res.headers.get("x-markdown-tokens")).toBe("5");
  });

  it("falls back to the HTML page (and its redirect) when the dedicated route does not resolve", async () => {
    const render = vi.fn(async (r: Request) => new URL(r.url).pathname.endsWith("/summary.md")
      ? new Response(null, { status: 301, headers: { location: "/meetings/new/summary.md" } })
      : new Response(null, { status: 301, headers: { location: "/meetings/new" } }));
    const res = await negotiateMarkdown(req("/meetings/old-slug", "text/markdown"), render);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/meetings/new");
    expect(res.headers.get("vary")).toBe("Accept");
  });

  it("returns headers only for HEAD and never touches API or file routes", async () => {
    const head = await negotiateMarkdown(req("/matters", "text/markdown", "HEAD"), async () => html());
    expect(head.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await head.text()).toBe("");
    const api = vi.fn(async (_: Request) => new Response("{}", { headers: { "content-type": "application/json" } }));
    for (const path of ["/api/search", "/sitemap.xml", "/meetings/x/summary.md"]) {
      const res = await negotiateMarkdown(req(path, "text/markdown"), api);
      expect(res.headers.get("content-type")).toBe("application/json");
    }
    expect(api.mock.calls.every(([r]) => (r as Request).headers.get("accept") === "text/markdown")).toBe(true);
  });
});
