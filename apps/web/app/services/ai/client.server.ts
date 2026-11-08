import type { z } from "zod";
import {
  getAiConfig,
  isAiConfigured,
  type AiConfig,
  type AiStage,
} from "./config.server";
import { AiError } from "./errors";
import { withHouseRules } from "./house-rules";
import { createOpenAIProvider } from "./providers/openai.server";
import type { Provider, ProviderRequest } from "./providers/types";
import {
  backoffDelay,
  deadlineSignal,
  defaultSleep,
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
  type Sleep,
} from "./retry";
import { toStrictJsonSchema, type JsonSchema } from "./schema";
import { consoleUsageHook, type AiUsageEvent, type AiUsageHook } from "./usage";
import { getPersistUsageHook } from "./usage-sink.server";
import { gatewayFetch } from "./gateway.server";

export interface AiCallOptions {
  stage: AiStage;
  /** Stage system prompt; house rules are always appended. */
  system?: string;
  prompt: string;
  /** Caller cancellation (e.g. client disconnected). */
  signal?: AbortSignal;
  /** Override the stage's per-attempt timeout. */
  timeoutMs?: number;
  /** Per-call usage callback, in addition to the client's default hook. */
  onUsage?: AiUsageHook;
}

export interface AiJsonOptions<S extends z.ZodType> extends AiCallOptions {
  schema: S;
  /** Schema name sent to the provider (letters, digits, _ and -). */
  schemaName: string;
}

export interface AiTextResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export type AiStreamChunk =
  | { type: "text"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number };

export interface AiClient {
  text(opts: AiCallOptions): Promise<AiTextResult>;
  json<S extends z.ZodType>(opts: AiJsonOptions<S>): Promise<AiTextResult & { data: z.infer<S> }>;
  stream(opts: AiCallOptions): AsyncGenerator<AiStreamChunk>;
  /** Embeds with the configured embedding model/dimensions (must match stored vectors). */
  embed(texts: string[], opts?: { signal?: AbortSignal; onUsage?: AiUsageHook }): Promise<number[][]>;
  isConfigured(): boolean;
  modelFor(stage: AiStage): string;
  readonly providerName: string;
}

export interface CreateAiClientOptions {
  config: AiConfig;
  provider: Provider;
  onUsage?: AiUsageHook;
  retry?: RetryPolicy;
  sleep?: Sleep;
  now?: () => number;
}

const schemaCache = new WeakMap<z.ZodType, JsonSchema>();
function jsonSchemaFor(schema: z.ZodType): JsonSchema {
  let cached = schemaCache.get(schema);
  if (!cached) {
    cached = toStrictJsonSchema(schema);
    schemaCache.set(schema, cached);
  }
  return cached;
}

export function createAiClient(options: CreateAiClientOptions): AiClient {
  const { config, provider } = options;
  const policy = options.retry ?? DEFAULT_RETRY_POLICY;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const defaultHook = options.onUsage ?? consoleUsageHook;

  function report(event: AiUsageEvent, extra?: AiUsageHook) {
    for (const hook of [defaultHook, extra]) {
      if (!hook) continue;
      try {
        hook(event);
      } catch (err) {
        console.error("[ai] usage hook failed", err);
      }
    }
  }

  function assertConfigured(stage: AiStage | "embedding", model: string) {
    if (!config.apiKey) {
      throw new AiError("config", "OPENAI_API_KEY is not configured", { stage, model });
    }
    if (config.problems.length) {
      throw new AiError("config", config.problems.join("; "), { stage, model });
    }
  }

  /**
   * Run `attempt` under the shared retry + timeout policy. `canRetry` lets streams
   * refuse to retry once output has been sent downstream.
   */
  async function withPolicy<T>(
    ctx: { stage: AiStage | "embedding"; model: string; timeoutMs: number; signal?: AbortSignal; maxAttempts?: number },
    attempt: (signal: AbortSignal) => Promise<T>,
    canRetry: () => boolean = () => true,
  ): Promise<{ value: T; attempts: number }> {
    let lastError: AiError | undefined;
    // A stage can ask for fewer attempts (config STAGE_MAX_ATTEMPTS); a retry policy given to the client wins.
    const maxAttempts = options.retry ? policy.maxAttempts : ctx.maxAttempts ?? policy.maxAttempts;
    for (let n = 1; n <= maxAttempts; n++) {
      const deadline = deadlineSignal(ctx.timeoutMs, ctx.signal);
      try {
        const value = await attempt(deadline.signal);
        return { value, attempts: n };
      } catch (raw) {
        let err = raw instanceof AiError ? raw : new AiError("http", String((raw as Error)?.message ?? raw), { cause: raw });
        if (deadline.timedOut()) {
          err = new AiError("timeout", `${ctx.stage} call timed out after ${ctx.timeoutMs}ms`, { cause: raw });
        }
        lastError = err.withContext({ stage: ctx.stage, model: ctx.model, attempts: n });
        const retry = lastError.retryable && n < maxAttempts && canRetry() && !ctx.signal?.aborted;
        if (!retry) throw lastError;
        const delay = backoffDelay(n, policy, lastError);
        console.warn(`[ai] ${ctx.stage} attempt ${n} failed (${lastError.message}); retrying in ${Math.round(delay)}ms`);
        await sleep(delay, ctx.signal);
      } finally {
        deadline.dispose();
      }
    }
    throw lastError!;
  }

  async function generate(opts: AiCallOptions, jsonSchema?: ProviderRequest["jsonSchema"]) {
    const stage = config.stages[opts.stage];
    const model = stage.model;
    const started = now();
    let attempts = 0;
    try {
      assertConfigured(opts.stage, model);
      const system = withHouseRules(opts.system);
      const { value, attempts: used } = await withPolicy(
        { stage: opts.stage, model, timeoutMs: opts.timeoutMs ?? stage.timeoutMs, signal: opts.signal, maxAttempts: stage.maxAttempts },
        (signal) => {
          attempts++;
          return provider.generate({ model, system, prompt: opts.prompt, signal, jsonSchema });
        },
      );
      attempts = used;
      return { value, model, started, attempts };
    } catch (err) {
      const e = err as AiError;
      report(
        {
          stage: opts.stage,
          provider: provider.name,
          model,
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: now() - started,
          attempts: e.attempts ?? attempts,
          ok: false,
          error: e.message,
        },
        opts.onUsage,
      );
      throw err;
    }
  }

  return {
    providerName: provider.name,

    isConfigured: () => isAiConfigured(config),

    modelFor: (stage) => config.stages[stage].model,

    async text(opts) {
      const { value, model, started, attempts } = await generate(opts);
      report(
        {
          stage: opts.stage,
          provider: provider.name,
          model,
          inputTokens: value.inputTokens,
          outputTokens: value.outputTokens,
          latencyMs: now() - started,
          attempts,
          ok: true,
        },
        opts.onUsage,
      );
      return { text: value.text, model, inputTokens: value.inputTokens, outputTokens: value.outputTokens };
    },

    async json(opts) {
      const schema = jsonSchemaFor(opts.schema);
      const { value, model, started, attempts } = await generate(opts, {
        name: opts.schemaName,
        schema,
      });
      const usageBase = {
        stage: opts.stage,
        provider: provider.name,
        model,
        inputTokens: value.inputTokens,
        outputTokens: value.outputTokens,
        attempts,
      };
      let data: unknown;
      try {
        data = parseJsonReply(value.text);
      } catch (cause) {
        const err = new AiError("schema", `${opts.stage}: model returned invalid JSON`, {
          stage: opts.stage,
          model,
          usage: { inputTokens: value.inputTokens, outputTokens: value.outputTokens },
          cause,
        });
        report({ ...usageBase, latencyMs: now() - started, ok: false, error: err.message }, opts.onUsage);
        throw err;
      }
      const parsed = opts.schema.safeParse(data);
      if (!parsed.success) {
        const err = new AiError(
          "schema",
          `${opts.stage}: output did not match ${opts.schemaName}: ${parsed.error.message}`,
          {
            stage: opts.stage,
            model,
            usage: { inputTokens: value.inputTokens, outputTokens: value.outputTokens },
            cause: parsed.error,
          },
        );
        report({ ...usageBase, latencyMs: now() - started, ok: false, error: err.message }, opts.onUsage);
        throw err;
      }
      report({ ...usageBase, latencyMs: now() - started, ok: true }, opts.onUsage);
      return {
        text: value.text,
        model,
        inputTokens: value.inputTokens,
        outputTokens: value.outputTokens,
        data: parsed.data,
      };
    },

    async *stream(opts) {
      const stage = config.stages[opts.stage];
      const model = stage.model;
      const started = now();
      let inputTokens = 0;
      let outputTokens = 0;
      let attempts = 0;
      let emitted = false;
      try {
        assertConfigured(opts.stage, model);
        const system = withHouseRules(opts.system);
        const timeoutMs = opts.timeoutMs ?? stage.timeoutMs;

        // Open the stream and pull the first chunk under the retry policy; once
        // text has gone downstream, failures are surfaced instead of retried.
        for (let n = 1; ; n++) {
          attempts = n;
          const deadline = deadlineSignal(timeoutMs, opts.signal);
          try {
            const iterator = provider
              .stream({ model, system, prompt: opts.prompt, signal: deadline.signal })
              [Symbol.asyncIterator]();
            while (true) {
              const next = await iterator.next();
              if (next.done) break;
              const chunk = next.value;
              if (chunk.type === "usage") {
                inputTokens = chunk.inputTokens;
                outputTokens = chunk.outputTokens;
              } else {
                emitted = true;
              }
              yield chunk;
            }
            break;
          } catch (raw) {
            let err = raw instanceof AiError ? raw : new AiError("http", String((raw as Error)?.message ?? raw), { cause: raw });
            if (deadline.timedOut()) {
              err = new AiError("timeout", `${opts.stage} stream timed out after ${timeoutMs}ms`, { cause: raw });
            }
            err = err.withContext({ stage: opts.stage, model, attempts: n });
            if (!err.retryable || emitted || n >= policy.maxAttempts || opts.signal?.aborted) throw err;
            const delay = backoffDelay(n, policy, err);
            console.warn(`[ai] ${opts.stage} stream attempt ${n} failed (${err.message}); retrying in ${Math.round(delay)}ms`);
            await sleep(delay, opts.signal);
          } finally {
            deadline.dispose();
          }
        }
        report(
          {
            stage: opts.stage,
            provider: provider.name,
            model,
            inputTokens,
            outputTokens,
            latencyMs: now() - started,
            attempts,
            ok: true,
          },
          opts.onUsage,
        );
      } catch (err) {
        report(
          {
            stage: opts.stage,
            provider: provider.name,
            model,
            inputTokens,
            outputTokens,
            latencyMs: now() - started,
            attempts,
            ok: false,
            error: (err as Error).message,
          },
          opts.onUsage,
        );
        throw err;
      }
    },

    async embed(texts, opts = {}) {
      const { model, dimensions, timeoutMs } = config.embedding;
      const started = now();
      let attempts = 0;
      try {
        assertConfigured("embedding", model);
        const { value, attempts: used } = await withPolicy(
          { stage: "embedding", model, timeoutMs, signal: opts.signal },
          (signal) => {
            attempts++;
            return provider.embed({ model, dimensions, input: texts, signal });
          },
        );
        attempts = used;
        for (const v of value.vectors) {
          if (v.length !== dimensions) {
            throw new AiError("schema", `Embedding has ${v.length} dims, expected ${dimensions}`, {
              stage: "embedding",
              model,
            });
          }
        }
        report(
          {
            stage: "embedding",
            provider: provider.name,
            model,
            inputTokens: value.inputTokens,
            outputTokens: 0,
            latencyMs: now() - started,
            attempts,
            ok: true,
          },
          opts.onUsage,
        );
        return value.vectors;
      } catch (err) {
        report(
          {
            stage: "embedding",
            provider: provider.name,
            model,
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: now() - started,
            attempts,
            ok: false,
            error: (err as Error).message,
          },
          opts.onUsage,
        );
        throw err;
      }
    },
  };
}

let defaultClient: AiClient | null = null;

/** The app-wide client, built lazily from env config. */
export function getAiClient(): AiClient {
  if (!defaultClient) {
    const config = getAiConfig();
    const persist = getPersistUsageHook();
    defaultClient = createAiClient({
      config,
      // In production every call goes through the AI Gateway binding (its spend limit, no fallback). The dev
      // server can't run that binding (it needs a remote preview session), so dev calls OpenAI directly with the
      // key from the env file when there is one.
      provider: createOpenAIProvider(config.gatewayId && !(import.meta.env.DEV && config.apiKey)
        ? { apiKey: "gateway-managed", fetch: gatewayFetch }
        : { apiKey: config.apiKey }),
      // Console log plus a fire-and-forget row in ai_usage (see usage-sink.server.ts).
      onUsage: persist
        ? (event) => {
            consoleUsageHook(event);
            persist(event);
          }
        : consoleUsageHook,
    });
  }
  return defaultClient;
}

/** Test hook: swap the app-wide client. Pass null to reset. */
export function setAiClientForTesting(client: AiClient | null) {
  defaultClient = client;
}

/**
 * Query embedding for vector search. Returns null when embeddings are unavailable
 * or fail, so search callers can fall back to keyword search; the failure is still
 * logged and reported through the usage hook.
 */
/**
 * The JSON object in a structured reply. The model occasionally puts a sentence of plain text before the object
 * ("I'll check the May 2012 minutes.{...}"; gpt-6.1-terra, record research, 2026-11-08), which strict output mode
 * doesn't prevent: the object itself is valid, so it is taken from the first brace to the last. Anything else throws.
 */
export function parseJsonReply(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw error;
    return JSON.parse(text.slice(start, end + 1));
  }
}

export async function embedQuery(text: string): Promise<number[] | null> {
  const client = getAiClient();
  if (!client.isConfigured()) return null;
  try {
    const [vector] = await client.embed([text]);
    return vector ?? null;
  } catch (err) {
    console.error("[ai] query embedding failed:", (err as Error).message);
    return null;
  }
}

/** Whether vector search can run (an embedding provider is configured). */
export function isVectorSearchAvailable(): boolean {
  return getAiClient().isConfigured();
}
