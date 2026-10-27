// Per-IP limiter for anonymous endpoints. Combines the Cloudflare binding
// (shared across isolates, when configured) with a per-isolate in-memory
// window so the limit still applies locally and in tests.
const WINDOW_MS = 60_000;
const logs = new Map<string, number[]>();

export function getClientIP(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

export async function isRateLimited(
  request: Request,
  scope: string,
  max: number,
  context?: { cloudflare?: { env?: { API_RATE_LIMITER?: RateLimit } } },
): Promise<boolean> {
  const ip = getClientIP(request);
  const key = `${scope}:${ip}`;
  const now = Date.now();
  for (const [k, ts] of logs.entries()) {
    const recent = ts.filter((t) => now - t < WINDOW_MS);
    if (recent.length === 0) logs.delete(k);
    else logs.set(k, recent);
  }
  const recent = logs.get(key) || [];
  recent.push(now);
  logs.set(key, recent);
  if (recent.length > max) return true;

  const binding = context?.cloudflare?.env?.API_RATE_LIMITER;
  if (binding) {
    try {
      return !(await binding.limit({ key })).success;
    } catch {
      return false;
    }
  }
  return false;
}

export function tooManyRequests() {
  return new Response("Too many requests. Please try again in a minute.", {
    status: 429,
    headers: { "Retry-After": "60", "Cache-Control": "no-store" },
  });
}
