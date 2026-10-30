/**
 * One URL per page for search engines and shared links: www.openlangford.ca → openlangford.ca and
 * "/meetings/" → "/meetings" (same query), as permanent redirects. GET/HEAD only, so a form post
 * is never turned into a GET.
 */
export function canonicalRedirect(request: Request, url: URL): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const www = url.hostname === "www.openlangford.ca";
  const slash = url.pathname.length > 1 && url.pathname.endsWith("/");
  if (!www && !slash) return null;
  const target = new URL(url);
  if (www) {
    target.hostname = "openlangford.ca";
    target.protocol = "https:";
  }
  if (slash) target.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return new Response(null, { status: 301, headers: { Location: target.toString(), "Cache-Control": "public, max-age=86400" } });
}
