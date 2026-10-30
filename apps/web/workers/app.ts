/// <reference types="@cloudflare/workers-types" />
import { createRequestHandler } from "react-router";
import apiApp from "../app/api";
import { CALENDAR_CRON, syncCalendar } from "../app/services/calendar-sync";
import { getSupabaseAdminClient } from "../app/lib/supabase.server";
import { runWithAiRequestContext } from "../app/services/ai/usage-sink.server";
import { withPublicDataCache } from "../app/services/public-data-cache.server";
import { timed, withServerTiming } from "../app/lib/server-timing.server";
import publicContent from "../public-content-version.json";

import { EMAIL_DISPATCH_CRON, dispatchEmailAlerts } from "./email-dispatch";
import { enqueueEnabled, enqueueMeetingEmails } from "./email-enqueue";
import { negotiateMarkdown } from "./markdown-negotiation";
import { publicMeetingCache } from "./public-meeting-cache";
import { contentVersion } from "./content-version";
import { canonicalRedirect } from "./canonical-redirect";

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE
);

type CacheVersion = { deploy?: string; stamp?: string };

async function handle(request: Request, env: Env, ctx: ExecutionContext, url: URL, { deploy, stamp }: CacheVersion) {
  // Cover paid generation and embedding-backed keyword search, including the
  // legacy endpoint. The database quota separately enforces the global day cap.
  if (url.pathname === "/api/search" || url.pathname === "/api/ask") {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (env.API_RATE_LIMITER && !(await env.API_RATE_LIMITER.limit({ key: `search:${ip}` })).success) {
      return new Response("Too many searches. Please try again in a minute.", {
        status: 429,
        headers: { "Retry-After": "60", "Cache-Control": "no-store" },
      });
    }
  }
  // Delegate /api/v1/* and /api/ocd/* requests to the Hono API app
  if (url.pathname.startsWith("/api/v1/") || url.pathname === "/api/v1" || url.pathname.startsWith("/api/ocd/") || url.pathname === "/api/ocd") {
    return apiApp.fetch(request, env, ctx);
  }

  // Everything else goes to React Router. Accept: text/markdown pages are
  // rendered as HTML through the caches, then converted (Markdown for Agents).
  return negotiateMarkdown(request, (pageRequest) => publicMeetingCache(pageRequest, {
    deploy,
    stamp,
    posthogKey: env.VITE_POSTHOG_KEY,
  }, ctx, (publicRequest) =>
    requestHandler(publicRequest, { cloudflare: { env, ctx } }),
  ));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const redirect = canonicalRedirect(request, url);
    if (redirect) return redirect;
    // AI usage rows are written via ctx.waitUntil, labelled with the route and request id.
    const aiContext = {
      gateway: env.AI_GATEWAY_ID ? env.AI.gateway(env.AI_GATEWAY_ID) : undefined,
      waitUntil: ctx.waitUntil.bind(ctx),
      requestId: request.headers.get("cf-ray") ?? crypto.randomUUID(),
      job: url.pathname,
    };
    // Pages are keyed by deployment (+ manual content bump); public data by the manual bump only, so
    // a deploy keeps warm data. Both carry when the database last changed: newer stamps make entries
    // stale (served while a fresh copy is computed in the background), so changes show within a minute.
    const deploy = env.CF_VERSION_METADATA?.id ? `${env.CF_VERSION_METADATA.id}:${publicContent.version}` : undefined;
    return withServerTiming(async () => {
      const stamp = deploy && request.method === "GET" ? (await timed("stamp", contentVersion())) ?? undefined : undefined;
      return runWithAiRequestContext(aiContext, () => withPublicDataCache({
        request, stamp, namespace: publicContent.version, posthogKey: env.VITE_POSTHOG_KEY, waitUntil: ctx.waitUntil.bind(ctx), kv: env.PUBLIC_CACHE,
      }, () => handle(request, env, ctx, url, { deploy, stamp })));
    });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (controller.cron === EMAIL_DISPATCH_CRON) {
      // Enqueue recently held meetings first (no-op unless all gates are set), then dispatch.
      ctx.waitUntil(
        (enqueueEnabled(env)
          ? enqueueMeetingEmails(env, getSupabaseAdminClient())
              .then((s) => { if (s.calls) console.log("[Email alerts] Enqueue", JSON.stringify(s)); })
              .catch(() => { console.error("[Email alerts] Enqueue failed; will retry next run"); })
          : Promise.resolve()
        ).then(() => dispatchEmailAlerts(env).catch(() => { console.error("[Email alerts] Dispatch failed; durable queue retained"); })),
      );
      return;
    }
    if (controller.cron === CALENDAR_CRON) {
      ctx.waitUntil(syncCalendar(getSupabaseAdminClient(), "cron").then(result => {
        console.log("[Calendar]", JSON.stringify("result" in result ? result.result : result));
      }).catch(error => { console.error("[Calendar] Sync failed; previous schedule retained"); throw error; }));
      return;
    }
    // Keeps a Vimeo fallback proxy warm, only for deployments that configure one (not Langford).
    const baseUrl = (env as unknown as { VIMEO_PROXY_FALLBACK_URL?: string }).VIMEO_PROXY_FALLBACK_URL;
    if (!baseUrl) return;
    const url = `${baseUrl}/health`;
    console.log(`[Cron] Pinging Render fallback: ${url}`);
    ctx.waitUntil(
      fetch(url)
        .then((res) => console.log(`[Cron] Render responded: ${res.status}`))
        .catch((err) => console.warn(`[Cron] Render ping failed: ${err}`))
    );
  },
} satisfies ExportedHandler<Env>;
