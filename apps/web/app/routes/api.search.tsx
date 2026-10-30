import { getSearchBudget, searchBudgetExceeded } from "../services/search-budget.server";
import { getCouncilTerms } from "../services/council-terms";
import type { Route } from "./+types/api.search";
import { classifyIntent } from "../lib/intent";
import {
  hybridSearchAll,
  getSearchResultCache,
  saveSearchResultCache,
  findCachedAnswer,
} from "../services/hybrid-search.server";
import { getDateRange } from "../lib/search-params";
import { runQuestionAgent, type AgentEvent } from "../services/rag.server";
import { getSupabaseAdminClient, createSupabaseServerClient } from "../lib/supabase.server";
import { getMunicipality } from "../services/municipality";
import { captureServerEvent } from "../lib/analytics.server";
import { z } from "zod";
import { createUsageCollector, getAiClient } from "../services/ai/index.server";

const FollowupsSchema = z.object({ questions: z.array(z.string()) });

// Simple in-memory rate limiter: max requests per IP within a window
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const ipRequestLog = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();

  // Clean stale entries inline instead of via setInterval (which breaks CF Workers)
  for (const [key, timestamps] of ipRequestLog.entries()) {
    const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length === 0) {
      ipRequestLog.delete(key);
    } else {
      ipRequestLog.set(key, recent);
    }
  }

  const timestamps = ipRequestLog.get(ip) || [];
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  ipRequestLog.set(ip, recent);
  return recent.length > RATE_LIMIT_MAX;
}

function getClientIP(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

/**
 * Unified search API route.
 *
 * GET /api/search?q=...             -> auto-detect intent (keyword or AI)
 * GET /api/search?q=...&mode=keyword -> force keyword search (JSON)
 * GET /api/search?q=...&mode=ai     -> force AI answer (streaming SSE)
 * GET /api/search?id=abc123         -> retrieve cached AI answer (JSON)
 */
export async function loader({ request, context: loaderContext }: Route.LoaderArgs) {
  const waitUntil = loaderContext.cloudflare?.ctx?.waitUntil?.bind(loaderContext.cloudflare.ctx);
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const query = url.searchParams.get("q");
  const modeParam = url.searchParams.get("mode");
  const context = url.searchParams.get("context") || undefined;

  // 1. Cached result lookup by ID
  if (id) {
    const cached = await getSearchResultCache(id);
    if (!cached) {
      return Response.json(
        { error: "Result not found or expired" },
        { status: 404 },
      );
    }
    return Response.json({
      answer: cached.answer,
      sources: cached.sources,
      suggested_followups: cached.suggested_followups,
      query: cached.query,
      cached: true,
    });
  }

  // 2. Require query for search
  if (!query) {
    return Response.json(
      {
        usage: {
          GET: {
            params: {
              q: "search query (required unless id is provided)",
              mode: "keyword | ai (optional, auto-detected if omitted)",
              context: "previous Q&A context for follow-ups (optional)",
              id: "cached result ID for shareable URLs (optional)",
              type: "filter by content type, repeatable (optional)",
            },
          },
        },
        examples: [
          "GET /api/search?q=tree+bylaw&mode=keyword",
          "GET /api/search?q=What+did+council+decide+about+housing?",
          "GET /api/search?id=abc123",
        ],
      },
      { status: 200 },
    );
  }

  if (query.length > 1000 || (context?.length || 0) > 24000) {
    return Response.json({ error: "Search query or conversation is too long" }, { status: 400 });
  }

  // 3. Determine mode
  let mode: "keyword" | "question";
  if (modeParam === "keyword") {
    mode = "keyword";
  } else if (modeParam === "ai" || modeParam === "question") {
    mode = "question";
  } else {
    mode = classifyIntent(query);
  }

  // 4. Keyword mode -> JSON response
  if (mode === "keyword") {
    const filterTypes = url.searchParams.getAll("type") as Array<
      | "matter"
      | "motion"
      | "key_statement"
      | "document_section"
      | "transcript_segment"
    >;
    const timeRange = url.searchParams.get("time") || "";
    const sortParam = url.searchParams.get("sort") || "";
    let { from: dateFrom, to: dateTo } = getDateRange(timeRange);
    const termId = url.searchParams.get("term");
    if (termId) {
      const { supabase } = createSupabaseServerClient(request);
      const municipality = await getMunicipality(supabase);
      const terms = await getCouncilTerms(supabase, municipality.id);
      const term = terms.find((item) => String(item.id) === termId);
      if (!term) return Response.json({ error: "Unknown council term" }, { status: 400 });
      dateFrom = dateFrom && dateFrom > term.start_date ? dateFrom : term.start_date;
      if (term.end_date) dateTo = dateTo && dateTo < term.end_date ? dateTo : term.end_date;
      if (dateTo && dateFrom > dateTo) return Response.json({ results: [], query, intent: "keyword" });
    }

    const results = await hybridSearchAll(query, {
      types: filterTypes.length > 0 ? filterTypes : undefined,
      limit: 30,
      dateFrom,
      dateTo,
      sort: (sortParam as "relevance" | "newest" | "oldest") || undefined,
    });

    return Response.json({ results, query, intent: "keyword" });
  }

  // 5. AI answer mode -> streaming SSE. Repeat questions (no follow-up context) reuse a
  // cached answer as long as no new meeting has been ingested since it was written.
  if (!context && url.searchParams.get("fresh") !== "1") {
    const cached = await findCachedAnswer(query);
    if (cached) {
      const encoder = new TextEncoder();
      const events = [
        { type: "sources", sources: cached.sources },
        { type: "final_answer_chunk", chunk: cached.answer },
        ...(cached.suggested_followups?.length ? [{ type: "suggested_followups", followups: cached.suggested_followups }] : []),
        { type: "cache_id", id: cached.id },
        { type: "cached", created_at: cached.created_at },
        { type: "done" },
      ];
      return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      });
    }
  }

  if (isRateLimited(getClientIP(request))) {
    return new Response("Too many requests. Please try again in a minute.", {
      status: 429,
    });
  }

  const budget = await getSearchBudget(loaderContext.cloudflare?.env?.AI_SEARCH_DAILY_LIMIT, true);
  if (!budget.available) return searchBudgetExceeded(budget);

  const { supabase } = createSupabaseServerClient(request);
  const municipality = await getMunicipality(supabase);

  // Collect streamed chunks for caching after completion
  let fullAnswer = "";
  let allSources: any[] = [];
  const streamStartTime = Date.now();
  let toolCallCount = 0;
  const ai = getAiClient();
  const usage = createUsageCollector();
  const aiModel = ai.modelFor("answer");
  const aiProvider = ai.providerName;
  // PostHog $ai_generation properties built from every model call this request made
  // (agent steps, rerank, answer stream, follow-ups), via the AI client's usage hook.
  const usageProperties = () => {
    const totals = usage.totals();
    return {
      $ai_input_tokens: totals.inputTokens,
      $ai_output_tokens: totals.outputTokens,
      ai_call_count: totals.calls,
      ai_failed_call_count: totals.failedCalls,
      ai_models: [...new Set(usage.events.map((e) => e.model))],
    };
  };

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const enqueue = (data: AgentEvent | { type: string; id?: string }) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        for await (const event of runQuestionAgent(
          query,
          context,
          undefined,
          municipality.name,
          { onUsage: usage.hook },
        )) {
          // Collect answer chunks and sources for caching
          if (event.type === "final_answer_chunk") {
            fullAnswer += event.chunk;
          } else if (event.type === "sources") {
            allSources = event.sources;
          } else if (event.type === "tool_call") {
            toolCallCount++;
          }

          // Stream all events except "done" (we add followups + cache_id before it)
          if (event.type === "done") {
            const cacheId = await saveSearchResultCache({
              query, answer: fullAnswer, sources: allSources,
              suggested_followups: [], source_count: allSources.length,
              cacheable: !context,
            });
            if (cacheId) enqueue({ type: "cache_id", id: cacheId });

            // Generate suggested follow-up questions
            let followups: string[] = [];
            try {
              if (ai.isConfigured() && fullAnswer.length > 50) {
                const followupPrompt = `Based on this civic question and answer about a municipal council, suggest 2-3 natural follow-up questions a citizen might ask.\n\nQuestion: ${query}\n\nAnswer summary: ${fullAnswer.slice(0, 500)}`;
                const followupResult = await ai.json({
                  stage: "followups",
                  prompt: followupPrompt,
                  schema: FollowupsSchema,
                  schemaName: "followup_questions",
                  onUsage: usage.hook,
                });
                // Cap at 3 suggestions
                followups = followupResult.data.questions
                  .map((q) => q.trim())
                  .filter(Boolean)
                  .slice(0, 3);
              }
            } catch (e) {
              // Non-critical: fall back to no suggestions
              console.error("Failed to generate follow-ups:", e);
            }

            if (followups.length > 0) {
              enqueue({ type: "suggested_followups", followups });
            }

            if (cacheId && followups.length) {
              const { error } = await getSupabaseAdminClient().from("search_results_cache")
                .update({ suggested_followups: followups }).eq("id", cacheId);
              if (error) console.error("Failed to cache follow-ups:", error.message);
            }

            captureServerEvent("$ai_generation", {
              $ai_trace_id: crypto.randomUUID(),
              $ai_model: aiModel,
              $ai_provider: aiProvider,
              $ai_input: query,
              $ai_output_choices: [fullAnswer],
              $ai_latency: (Date.now() - streamStartTime) / 1000,
              $ai_http_status: 200,
              ...usageProperties(),
              $ai_stream: true,
              source_count: allSources.length,
              tool_call_count: toolCallCount,
            }, waitUntil);

            enqueue({ type: "done" });
          } else {
            enqueue(event);
          }
        }
      } catch (error: any) {
        console.error("Streaming search error:", error);
        captureServerEvent("$ai_generation", {
          $ai_trace_id: crypto.randomUUID(),
          $ai_model: aiModel,
          $ai_provider: aiProvider,
          $ai_input: query,
          $ai_http_status: 500,
          $ai_is_error: true,
          $ai_error: error.message,
          ...usageProperties(),
        }, waitUntil);
        const errorEvent: AgentEvent = {
          type: "final_answer_chunk",
          chunk: `\n\n**Error:** An unexpected error occurred. (${error.message})`,
        };
        enqueue(errorEvent);
        enqueue({ type: "done" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
