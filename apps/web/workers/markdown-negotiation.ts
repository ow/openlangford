/// <reference types="@cloudflare/workers-types" />

import { NodeHtmlMarkdown } from "node-html-markdown";
import { parse } from "node-html-parser";

// Markdown for Agents: `Accept: text/markdown` gets a Markdown representation of
// the same URL; HTML stays the default. Meetings and documents already have
// purpose-built Markdown routes; every other page is converted from its HTML.

const NOISE = "script, style, noscript, template, svg, iframe, nav, form, button, dialog, [hidden], [aria-hidden=true]";
// Keep in step with public/robots.txt.
export const CONTENT_SIGNAL = "ai-train=no, search=yes, ai-input=yes";
const converter = new NodeHtmlMarkdown({ bulletMarker: "-", codeBlockStyle: "fenced", maxConsecutiveNewlines: 2 });

function quality(accept: string, type: string): number {
  let best = 0;
  for (const range of accept.split(",")) {
    const [media, ...params] = range.trim().toLowerCase().split(";");
    if (media.trim() !== type) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    best = Math.max(best, q ? Number(q.slice(2)) || 0 : 1);
  }
  return best;
}

/** True when the client asks for Markdown at least as much as for HTML. */
export function prefersMarkdown(request: Request): boolean {
  const accept = request.headers.get("accept") || "";
  const markdown = quality(accept, "text/markdown");
  return markdown > 0 && markdown >= quality(accept, "text/html");
}

/** The dedicated Markdown route for a meeting or document page, if there is one. */
export function markdownRoute(pathname: string): string | null {
  const meeting = /^\/meetings\/([a-z0-9-]+)\/?$/.exec(pathname);
  if (meeting && !/^\d+$/.test(meeting[1]) && meeting[1] !== "explorer") return `/meetings/${meeting[1]}/summary.md`;
  const document = /^\/meetings\/([a-z0-9-]+)\/documents\/([1-9]\d*)\/?$/.exec(pathname);
  if (document) return `/meetings/${document[1]}/documents/${document[2]}/content.md`;
  return null;
}

// Rough GPT-style estimate (about four characters per token), as an agent budget hint.
export const estimateTokens = (markdown: string) => Math.ceil(markdown.length / 4);

export function htmlToMarkdown(html: string, pageUrl: string): string {
  const root = parse(html, { comment: false });
  const meta = (selector: string) => root.querySelector(selector)?.getAttribute("content")?.trim() || "";
  const canonical = root.querySelector('link[rel="canonical"]')?.getAttribute("href") || pageUrl;
  const front: [string, string][] = [
    ["title", root.querySelector("title")?.text.trim() || ""],
    ["description", meta('meta[name="description"]') || meta('meta[property="og:description"]')],
    ["image", meta('meta[property="og:image"]')],
    ["url", canonical],
  ];
  const body = root.querySelector("main") || root.querySelector("body") || root;
  body.querySelectorAll(NOISE).forEach((node) => node.remove());
  // Relative links would be meaningless once the Markdown leaves this page.
  for (const [selector, attribute] of [["a[href]", "href"], ["img[src]", "src"]] as const) {
    for (const node of body.querySelectorAll(selector)) {
      try { node.setAttribute(attribute, new URL(node.getAttribute(attribute)!, pageUrl).href); } catch { /* keep as written */ }
    }
  }
  const content = converter.translate(body.innerHTML).trim();
  const yaml = front.filter(([, value]) => value).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
  return `${yaml ? `---\n${yaml}\n---\n\n` : ""}${content}\n`;
}

function addVaryAccept(headers: Headers) {
  const vary = headers.get("vary");
  if (!vary) headers.set("Vary", "Accept");
  else if (!vary.split(",").some((v) => ["accept", "*"].includes(v.trim().toLowerCase()))) headers.set("Vary", `${vary}, Accept`);
}

function markdownResponse(markdown: string, from: Response, request: Request): Response {
  const headers = new Headers(from.headers);
  for (const name of ["content-length", "content-encoding", "etag", "last-modified"]) headers.delete(name);
  headers.set("Content-Type", "text/markdown; charset=utf-8");
  if (!headers.has("content-signal")) headers.set("Content-Signal", CONTENT_SIGNAL);
  headers.set("x-markdown-tokens", String(estimateTokens(markdown)));
  addVaryAccept(headers);
  return new Response(request.method === "HEAD" ? null : markdown, { status: from.status, statusText: from.statusText, headers });
}

/**
 * Wrap the page renderer. `render` receives the request to run; Markdown requests
 * are rendered as ordinary HTML navigations (so the HTML caches still apply) and
 * converted here, after every cache layer.
 */
export async function negotiateMarkdown(
  request: Request,
  render: (request: Request) => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  const page = (request.method === "GET" || request.method === "HEAD") && !url.pathname.startsWith("/api/") && !/\.\w+$/.test(url.pathname);
  if (!page) return render(request);
  if (!prefersMarkdown(request)) {
    const response = await render(request);
    if ((response.headers.get("content-type") || "").startsWith("text/html")) {
      const varied = new Response(response.body, response);
      addVaryAccept(varied.headers);
      return varied;
    }
    return response;
  }

  const route = markdownRoute(url.pathname);
  if (route) {
    const target = new URL(route + url.search, url);
    const response = await render(new Request(target, { method: request.method, headers: request.headers }));
    if (response.status === 200 && (response.headers.get("content-type") || "").startsWith("text/markdown")) {
      return markdownResponse(await response.text(), response, request);
    }
    // Unknown or renamed meetings fall through to the HTML page's own 404/redirect.
  }

  const headers = new Headers(request.headers);
  headers.set("Accept", "text/html");
  const response = await render(new Request(request.url, { method: "GET", headers }));
  if (!(response.headers.get("content-type") || "").startsWith("text/html")) {
    const passed = new Response(response.body, response);
    addVaryAccept(passed.headers);
    return passed;
  }
  return markdownResponse(htmlToMarkdown(await response.text(), url.href), response, request);
}
