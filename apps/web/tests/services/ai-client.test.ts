import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAiClient } from "../../app/services/ai/client.server";
import { resolveAiConfig, type AiConfig } from "../../app/services/ai/config.server";
import { AiError } from "../../app/services/ai/errors";
import { HOUSE_RULES, withHouseRules } from "../../app/services/ai/house-rules";
import { createOpenAIProvider } from "../../app/services/ai/providers/openai.server";
import type { Provider, ProviderRequest } from "../../app/services/ai/providers/types";
import { toStrictJsonSchema } from "../../app/services/ai/schema";
import type { AiUsageEvent } from "../../app/services/ai/usage";
import { AGENT_TOOL_NAMES, AgentDecisionSchema, RerankSchema } from "../../app/services/rag.server";
import { AgendaItemIntelligenceSchema } from "../../app/services/ai/agenda-intelligence";

const config = (env: Record<string, string> = {}): AiConfig =>
  resolveAiConfig({ OPENAI_API_KEY: "sk-test", ...env });

function fakeProvider(overrides: Partial<Provider> = {}) {
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    name: "fake",
    generate: vi.fn(async (req: ProviderRequest) => {
      requests.push(req);
      return { text: "hello", inputTokens: 10, outputTokens: 5 };
    }),
    async *stream(req: ProviderRequest) {
      requests.push(req);
      yield { type: "text" as const, text: "a" };
      yield { type: "text" as const, text: "b" };
      yield { type: "usage" as const, inputTokens: 3, outputTokens: 2 };
    },
    embed: vi.fn(async (req) => ({ vectors: req.input.map(() => new Array(req.dimensions).fill(0)), inputTokens: 1 })),
    ...overrides,
  };
  return { provider, requests };
}

function client(provider: Provider, cfg = config()) {
  const usage: AiUsageEvent[] = [];
  const sleep = vi.fn(async () => {});
  const ai = createAiClient({ config: cfg, provider, onUsage: (e) => usage.push(e), sleep });
  return { ai, usage, sleep };
}

describe("resolveAiConfig", () => {
  it("defaults every stage to gpt-6-luna on openai", () => {
    const cfg = resolveAiConfig({});
    expect(cfg.stages.agent.model).toBe("gpt-6-luna");
    expect(cfg.stages.rerank.model).toBe("gpt-6-luna");
    expect(cfg.stages.extraction.provider).toBe("openai");
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.problems).toEqual([]);
  });

  it("prefers stage-specific models, then AI_MODEL", () => {
    const cfg = resolveAiConfig({
      AI_MODEL: "base",
      RAG_AI_MODEL: "rag-model",
      RERANK_AI_MODEL: "  ",
      EXTRACTION_AI_MODEL: "extract-model",
    });
    expect(cfg.stages.agent.model).toBe("rag-model");
    expect(cfg.stages.answer.model).toBe("rag-model");
    expect(cfg.stages.followups.model).toBe("rag-model");
    expect(cfg.stages.rerank.model).toBe("base");
    expect(cfg.stages.extraction.model).toBe("extract-model");
  });

  it("picks each check's model: verify, summary and note checks follow REVIEW_AI_MODEL, the related-topics check AI_MODEL, each overridable", () => {
    const base = { AI_MODEL: "fast", REVIEW_AI_MODEL: "strong" };
    const cfg = resolveAiConfig(base);
    expect(cfg.stages.verify.model).toBe("strong");
    expect(cfg.stages.summary_check.model).toBe("strong");
    expect(cfg.stages.note_check.model).toBe("strong");
    expect(cfg.stages.related_check.model).toBe("fast");
    const over = resolveAiConfig({ ...base, NOTE_CHECK_AI_MODEL: "n", RELATED_CHECK_AI_MODEL: "r", VERIFY_AI_MODEL: "v" });
    expect([over.stages.note_check.model, over.stages.related_check.model, over.stages.verify.model]).toEqual(["n", "r", "v"]);
  });

  it("flags non-openai providers instead of silently using them", () => {
    const cfg = resolveAiConfig({ OPENAI_API_KEY: "k", RERANK_AI_PROVIDER: "gemini" });
    expect(cfg.problems).toHaveLength(1);
    expect(cfg.problems[0]).toMatch(/gemini/);
  });

  it("reads embedding model and dimensions with stored-vector defaults", () => {
    expect(resolveAiConfig({}).embedding).toMatchObject({ model: "text-embedding-3-small", dimensions: 384 });
    expect(resolveAiConfig({ EMBEDDING_MODEL: "m", EMBEDDING_DIMENSIONS: "512" }).embedding).toMatchObject({
      model: "m",
      dimensions: 512,
    });
    const bad = resolveAiConfig({ EMBEDDING_DIMENSIONS: "abc" });
    expect(bad.embedding.dimensions).toBe(384);
    expect(bad.problems[0]).toMatch(/EMBEDDING_DIMENSIONS/);
  });
});

describe("house rules", () => {
  it("appends the pronoun rule to a system prompt, or stands alone", () => {
    expect(withHouseRules("Be brief.")).toBe(`Be brief.\n\n${HOUSE_RULES}`);
    expect(withHouseRules()).toBe(HOUSE_RULES);
  });

  it("is applied to text, json and stream calls", async () => {
    const { provider, requests } = fakeProvider({
      generate: async (req) => {
        requests.push(req);
        return { text: '{"ok":true}', inputTokens: 1, outputTokens: 1 };
      },
    });
    const { ai } = client(provider);
    await ai.text({ stage: "agent", system: "SYS", prompt: "p" });
    await ai.json({ stage: "rerank", prompt: "p", schema: z.object({ ok: z.boolean() }), schemaName: "x" });
    for await (const _ of ai.stream({ stage: "answer", system: "S2", prompt: "p" })) {
      // drain
    }
    expect(requests).toHaveLength(3);
    for (const req of requests) expect(req.system).toContain(HOUSE_RULES);
    expect(requests[0].system.startsWith("SYS")).toBe(true);
  });
});

describe("retry and timeout policy", () => {
  it("retries 429 and 5xx, then succeeds", async () => {
    let calls = 0;
    const { provider } = fakeProvider({
      generate: async () => {
        calls++;
        if (calls === 1) throw new AiError("http", "rate limited", { status: 429 });
        if (calls === 2) throw new AiError("http", "bad gateway", { status: 502 });
        return { text: "ok", inputTokens: 1, outputTokens: 1 };
      },
    });
    const { ai, usage, sleep } = client(provider);
    const result = await ai.text({ stage: "agent", prompt: "p" });
    expect(result.text).toBe("ok");
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ stage: "agent", ok: true, attempts: 3, model: "gpt-6-luna" });
  });

  it("gives up after 3 attempts and reports the failure", async () => {
    const generate = vi.fn(async () => {
      throw new AiError("network", "socket hang up");
    });
    const { provider } = fakeProvider({ generate });
    const { ai, usage } = client(provider);
    await expect(ai.text({ stage: "rerank", prompt: "p" })).rejects.toMatchObject({
      kind: "network",
      stage: "rerank",
      attempts: 3,
    });
    expect(generate).toHaveBeenCalledTimes(3);
    expect(usage[0]).toMatchObject({ ok: false, attempts: 3 });
    expect(usage[0].error).toMatch(/socket hang up/);
  });

  it("does not retry 4xx client errors", async () => {
    const generate = vi.fn(async () => {
      throw new AiError("http", "bad request", { status: 400 });
    });
    const { ai } = client(fakeProvider({ generate }).provider);
    await expect(ai.text({ stage: "agent", prompt: "p" })).rejects.toMatchObject({ status: 400 });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("aborts slow attempts with a timeout error and retries them", async () => {
    const generate = vi.fn(
      (req: ProviderRequest) =>
        new Promise<never>((_, reject) => {
          req.signal.addEventListener("abort", () => reject(new AiError("aborted", "aborted")));
        }),
    );
    const { ai } = client(fakeProvider({ generate }).provider);
    await expect(ai.text({ stage: "agent", prompt: "p", timeoutMs: 5 })).rejects.toMatchObject({
      kind: "timeout",
      attempts: 3,
    });
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it("retries a stream that fails before output, but not after", async () => {
    let opens = 0;
    const { provider } = fakeProvider({
      async *stream() {
        opens++;
        if (opens === 1) throw new AiError("http", "overloaded", { status: 503 });
        yield { type: "text" as const, text: "partial" };
        throw new AiError("http", "overloaded", { status: 503 });
      },
    });
    const { ai, usage } = client(provider);
    const chunks: string[] = [];
    await expect(async () => {
      for await (const c of ai.stream({ stage: "answer", prompt: "p" })) {
        if (c.type === "text") chunks.push(c.text);
      }
    }).rejects.toMatchObject({ status: 503 });
    expect(opens).toBe(2);
    expect(chunks).toEqual(["partial"]);
    expect(usage[0]).toMatchObject({ stage: "answer", ok: false });
  });

  it("fails fast with a config error when no API key is set", async () => {
    const { provider } = fakeProvider();
    const { ai } = client(provider, resolveAiConfig({}));
    expect(ai.isConfigured()).toBe(false);
    await expect(ai.text({ stage: "agent", prompt: "p" })).rejects.toMatchObject({ kind: "config" });
    expect(provider.generate).not.toHaveBeenCalled();
  });
});

describe("json structured output", () => {
  const Schema = z.object({ scores: z.array(z.object({ index: z.number().int(), score: z.number() })) });

  it("sends a strict JSON schema and returns validated data", async () => {
    const { provider, requests } = fakeProvider({
      generate: async (req) => {
        requests.push(req);
        return { text: '{"scores":[{"index":0,"score":7}]}', inputTokens: 4, outputTokens: 2 };
      },
    });
    const { ai } = client(provider);
    const result = await ai.json({ stage: "rerank", prompt: "p", schema: Schema, schemaName: "rerank_scores" });
    expect(result.data.scores[0]).toEqual({ index: 0, score: 7 });
    expect(requests[0].jsonSchema?.name).toBe("rerank_scores");
    expect(requests[0].jsonSchema?.schema).toMatchObject({ type: "object", additionalProperties: false });
  });

  it("throws a schema error when output does not validate", async () => {
    const { provider } = fakeProvider({
      generate: async () => ({ text: '{"scores":"nope"}', inputTokens: 1, outputTokens: 1 }),
    });
    const { ai, usage } = client(provider);
    await expect(
      ai.json({ stage: "rerank", prompt: "p", schema: Schema, schemaName: "s" }),
    ).rejects.toMatchObject({ kind: "schema" });
    expect(usage[0].ok).toBe(false);
  });

  it("produces OpenAI-strict schemas for every app schema", () => {
    for (const schema of [AgentDecisionSchema, RerankSchema, AgendaItemIntelligenceSchema]) {
      const json = JSON.stringify(toStrictJsonSchema(schema));
      expect(json).not.toContain("oneOf");
      expect(json).not.toContain("$schema");
    }
    expect(() => toStrictJsonSchema(z.object({ a: z.string().optional() }))).toThrow(/nullable/);
    expect(() => toStrictJsonSchema(z.array(z.string()))).toThrow(/object at the root/);
  });

  it("agent decision schema covers exactly the agent's tools", () => {
    const json = toStrictJsonSchema(AgentDecisionSchema) as any;
    const toolNames = json.properties.next.anyOf
      .map((variant: any) => variant.properties.tool?.const)
      .filter(Boolean);
    expect(toolNames.sort()).toEqual([...AGENT_TOOL_NAMES].sort());
  });
});

describe("OpenAI provider", () => {
  function mockFetch(body: unknown, status = 200) {
    const calls: { url: string; body: any }[] = [];
    const fetchImpl = vi.fn(async (url: any, init?: any) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...(status === 429 ? { "retry-after": "2" } : {}) },
      });
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
  }

  it("sets text.format json_schema (strict) on the Responses request", async () => {
    const { fetchImpl, calls } = mockFetch({
      id: "resp_1",
      object: "response",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: '{"scores":[{"index":1,"score":9}]}', annotations: [] }],
        },
      ],
      usage: { input_tokens: 12, output_tokens: 3 },
    });
    const provider = createOpenAIProvider({ apiKey: "sk-test", fetch: fetchImpl });
    const { ai, usage } = client(provider);
    const result = await ai.json({ stage: "rerank", system: "S", prompt: "P", schema: RerankSchema, schemaName: "rerank_scores" });

    expect(result.data.scores).toEqual([{ index: 1, score: 9 }]);
    expect(calls[0].url).toMatch(/\/responses$/);
    expect(calls[0].body.text.format).toMatchObject({ type: "json_schema", name: "rerank_scores", strict: true });
    expect(calls[0].body.instructions).toContain(HOUSE_RULES);
    expect(calls[0].body.store).toBe(false);
    expect(usage[0]).toMatchObject({ inputTokens: 12, outputTokens: 3, ok: true });
  });

  it("maps 429 to a retryable error honouring Retry-After", async () => {
    const { fetchImpl } = mockFetch({ error: { message: "slow down" } }, 429);
    const provider = createOpenAIProvider({ apiKey: "sk-test", fetch: fetchImpl });
    const err = await provider
      .generate({ model: "m", system: "s", prompt: "p", signal: new AbortController().signal })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err.status).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterSeconds).toBe(2);
  });

  it("embeds with the configured model and dimensions", async () => {
    const { fetchImpl, calls } = mockFetch({
      object: "list",
      data: [{ object: "embedding", index: 0, embedding: new Array(384).fill(0.1) }],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 2, total_tokens: 2 },
    });
    const provider = createOpenAIProvider({ apiKey: "sk-test", fetch: fetchImpl });
    const { ai } = client(provider);
    const [vector] = await ai.embed(["tree bylaw"]);
    expect(vector).toHaveLength(384);
    expect(calls[0].body).toMatchObject({ model: "text-embedding-3-small", dimensions: 384, input: ["tree bylaw"], encoding_format: "float" });
  });
});

describe("runQuestionAgent with the AI client", () => {
  it("recovers from a malformed step, then streams the final answer", async () => {
    const { runQuestionAgent } = await import("../../app/services/rag.server");
    const { setAiClientForTesting } = await import("../../app/services/ai/client.server");
    let step = 0;
    const { provider, requests } = fakeProvider({
      generate: async (req) => {
        requests.push(req);
        step++;
        if (step === 1) return { text: '{"thought":"x","next":{"action":"bogus"}}', inputTokens: 1, outputTokens: 1 };
        return { text: '{"thought":"enough","next":{"action":"answer"}}', inputTokens: 2, outputTokens: 2 };
      },
    });
    const { ai, usage } = client(provider);
    setAiClientForTesting(ai);
    try {
      const events = [];
      for await (const e of runQuestionAgent("Why is garbage collection changing?")) events.push(e);
      expect(events.map((e) => e.type)).toEqual([
        "tool_observation",
        "thought",
        "sources",
        "final_answer_chunk",
        "final_answer_chunk",
        "usage_metadata",
        "done",
      ]);
      expect(requests[0].jsonSchema?.name).toBe("agent_decision");
      expect(usage.map((u) => u.stage)).toEqual(["agent", "agent", "answer"]);
      expect(events.find((e) => e.type === "usage_metadata")).toMatchObject({ inputTokens: 6, outputTokens: 5 });
    } finally {
      setAiClientForTesting(null);
    }
  });
});
