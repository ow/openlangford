/**
 * PostHog through the site's own address (openlangford.ca/relay/...), so blockers that drop requests to analytics
 * domains don't skew the counts. Only what PostHog needs is passed on: never the site's cookies (sign-in sessions)
 * or the visitor's IP address, and nothing PostHog sets comes back.
 */
export const POSTHOG_PROXY_PATH = "/relay";

const API_HOST = "us.i.posthog.com";
const ASSET_HOST = "us-assets.i.posthog.com";
const FORWARDED_HEADERS = ["accept", "accept-encoding", "accept-language", "content-type", "content-encoding", "user-agent"];

/** The PostHog URL a relay request goes to, or null when the path isn't the relay's. */
export function posthogTarget(url: URL): URL | null {
  if (url.pathname !== POSTHOG_PROXY_PATH && !url.pathname.startsWith(`${POSTHOG_PROXY_PATH}/`)) return null;
  const path = url.pathname.slice(POSTHOG_PROXY_PATH.length) || "/";
  return new URL(`${path}${url.search}`, `https://${path.startsWith("/static/") ? ASSET_HOST : API_HOST}`);
}

export async function posthogProxy(request: Request, url: URL, send: typeof fetch = fetch): Promise<Response | null> {
  const target = posthogTarget(url);
  if (!target) return null;
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const upstream = await send(target.toString(), {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    redirect: "manual",
  });
  const response = new Response(upstream.body, upstream);
  response.headers.delete("set-cookie");
  return response;
}
