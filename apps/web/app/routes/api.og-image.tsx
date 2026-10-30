import type { AppLoadContext } from "react-router";
import { OG_VERSION } from "../lib/og";
import { ogCardInput } from "../services/og/card";
import { renderOgPng } from "../services/og/render.server";

// Share images (og:image) for pages without their own. Each distinct URL renders once: the PNG is
// kept in the colo cache (Cache API) and in KV (PUBLIC_CACHE) so other colos reuse it. URLs from
// ogImageUrl carry OG_VERSION and all card text, so a change gives a new URL; those are immutable.

const IMMUTABLE = "public, max-age=31536000, immutable";
/** Unversioned (pre-v2) URLs still render, but may change when the design does. */
const LEGACY = "public, max-age=86400";
const KV_TTL_SECONDS = 60 * 60 * 24 * 180;

type Env = Partial<Pick<Cloudflare.Env, "PUBLIC_CACHE" | "API_RATE_LIMITER">> & { ASSETS?: Fetcher };

async function cacheKey(url: URL): Promise<string> {
  const input = ogCardInput(url.searchParams);
  const canonical = JSON.stringify([OG_VERSION, input.label, input.title, input.subtitle || "", input.imagePath || ""]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const hex = [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `og:${OG_VERSION}:${hex}`;
}

function png(body: ArrayBuffer | Uint8Array, cacheControl: string, status = "hit"): Response {
  return new Response(body as BodyInit, {
    headers: { "Content-Type": "image/png", "Cache-Control": cacheControl, "X-Og-Cache": status, "Content-Length": String(body.byteLength) },
  });
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A site portrait as a data: URI, read from the static assets. Missing or failed: no portrait. */
async function portrait(env: Env, url: URL, path: string | undefined): Promise<string | undefined> {
  if (!path || !env.ASSETS) return undefined;
  try {
    const response = await env.ASSETS.fetch(new URL(path, url.origin).toString());
    const type = response.headers.get("Content-Type") || "";
    if (!response.ok || !/^image\/(jpeg|png)/.test(type)) return undefined;
    return `data:${type.split(";")[0]};base64,${toBase64(new Uint8Array(await response.arrayBuffer()))}`;
  } catch {
    return undefined;
  }
}

export async function loader({ request, context }: { request: Request; context?: AppLoadContext }) {
  const env: Env = (context?.cloudflare?.env as Env | undefined) ?? {};
  const waitUntil = (promise: Promise<unknown>) => context?.cloudflare?.ctx?.waitUntil(promise.catch(() => {}));
  const url = new URL(request.url);
  const versioned = url.searchParams.get("v") === OG_VERSION;
  const cacheControl = versioned ? IMMUTABLE : LEGACY;
  const key = await cacheKey(url);
  const edgeKey = new Request(`https://og-cache.internal/${key}`);
  const edge = typeof caches !== "undefined" ? (caches as unknown as { default?: Cache }).default : undefined;

  const cached = await edge?.match(edgeKey).catch(() => undefined);
  if (cached) return png(await cached.arrayBuffer(), cacheControl);
  const stored = await env.PUBLIC_CACHE?.get(key, "arrayBuffer").catch(() => null);
  if (stored && stored.byteLength) {
    if (edge) waitUntil(edge.put(edgeKey, png(stored, IMMUTABLE)));
    return png(stored, cacheControl);
  }

  // Rendering costs CPU; cap misses per visitor (crawlers fetch a handful of images, not hundreds).
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (env.API_RATE_LIMITER && !(await env.API_RATE_LIMITER.limit({ key: `og:${ip}` })).success) {
    return Response.redirect(new URL("/og-image.png", url.origin).toString(), 302);
  }

  const input = ogCardInput(url.searchParams);
  let body: Uint8Array;
  try {
    body = await renderOgPng({ ...input, image: await portrait(env, url, input.imagePath) });
  } catch (error) {
    console.error("og-image render failed", error);
    // Never an empty 200: send the static brand card, briefly cached so a fix shows quickly.
    return new Response(null, {
      status: 302,
      headers: { Location: new URL("/og-image.png", url.origin).toString(), "Cache-Control": "public, max-age=300" },
    });
  }
  if (edge) waitUntil(edge.put(edgeKey, png(body, IMMUTABLE)));
  if (versioned && env.PUBLIC_CACHE) waitUntil(env.PUBLIC_CACHE.put(key, body, { expirationTtl: KV_TTL_SECONDS }));
  return png(body, cacheControl, "miss");
}
