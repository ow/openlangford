/**
 * AI configuration: one place that turns env vars into per-stage settings.
 *
 * Env vars are read via literal `process.env.X` references so Vite's `define`
 * can inline them at build time (process.env doesn't exist on Workers).
 */

export type AiStage =
  /** ReAct research steps in the question agent. */
  | "agent"
  /** Streamed final answer synthesis. */
  | "answer"
  /** Suggested follow-up questions after an answer. */
  | "followups"
  /** Relevance scoring of retrieved evidence. */
  | "rerank"
  /** Structured extraction (agenda-item intelligence). */
  | "extraction"
  /** Staff page checks: a reader's review of a public page (services/page-check.server.ts). */
  | "review"
  /** Public text: a topic's summary, rewritten after a staff fix (services/topic-summaries.server.ts), as the pipeline's
   * "writing" stage writes it. */
  | "writing"
  /** The page check's comparison of a page's statements with the records (page-verify.server.ts). Strong model. */
  | "verify"
  /** The summary check after a rewrite: facts and staff instructions in one call (topic-summaries.server.ts). Strong model. */
  | "summary_check"
  /** Whether a summary follows a staff instruction, checked alone (topic-summaries.server.ts). Strong model by default. */
  | "note_check"
  /** Whether a Related topics card belongs (page-check.server.ts). Fast model. */
  | "related_check";

export type AiProviderName = "openai";

export type AiEnv = Record<string, string | undefined>;

export const DEFAULT_MODEL = "gpt-6-luna";
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
/** Stored vectors are 384-dim text-embedding-3-small; don't change without re-embedding. */
export const DEFAULT_EMBEDDING_DIMENSIONS = 384;

/** Which `<PREFIX>_AI_MODEL` / `<PREFIX>_AI_PROVIDER` env vars a stage reads. */
const STAGE_ENV_PREFIX: Record<AiStage, string> = {
  agent: "RAG",
  answer: "RAG",
  followups: "RAG",
  rerank: "RERANK",
  extraction: "EXTRACTION",
  review: "REVIEW",
  writing: "WRITING",
  verify: "VERIFY",
  summary_check: "SUMMARY_CHECK",
  note_check: "NOTE_CHECK",
  related_check: "RELATED_CHECK",
};

/** Stages whose model falls back to the review stage's (REVIEW_AI_MODEL) before the site's AI_MODEL. related_check
 * defaults to the fast AI_MODEL. Each is overridable by its own env var (NOTE_CHECK_AI_MODEL, RELATED_CHECK_AI_MODEL, ...).
 * note_check stays on the strong model: replayed on 40 real instructions, the fast model disagreed on 25% (scripts/replay-checks.ts). */
const FOLLOWS_REVIEW: AiStage[] = ["verify", "summary_check", "note_check"];

/** Per-attempt timeouts. Streams use this as the total budget for the stream. */
export const STAGE_TIMEOUT_MS: Record<AiStage, number> = {
  agent: 45_000,
  answer: 90_000,
  followups: 20_000,
  rerank: 20_000,
  extraction: 120_000,
  review: 90_000,
  writing: 300_000,
  verify: 90_000,
  summary_check: 90_000,
  note_check: 20_000,
  related_check: 30_000,
};

export const EMBEDDING_TIMEOUT_MS = 10_000;

export interface StageConfig {
  stage: AiStage;
  provider: AiProviderName;
  model: string;
  timeoutMs: number;
}

export interface AiConfig {
  apiKey?: string;
  gatewayId?: string;
  stages: Record<AiStage, StageConfig>;
  embedding: { model: string; dimensions: number; timeoutMs: number };
  /** Set when the env asks for something we can't serve (e.g. a non-OpenAI provider). */
  problems: string[];
}

export function readAiEnv(): AiEnv {
  return {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    AI_GATEWAY_ID: process.env.AI_GATEWAY_ID,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    AI_PROVIDER: process.env.AI_PROVIDER,
    AI_MODEL: process.env.AI_MODEL,
    RAG_AI_PROVIDER: process.env.RAG_AI_PROVIDER,
    RAG_AI_MODEL: process.env.RAG_AI_MODEL,
    RERANK_AI_PROVIDER: process.env.RERANK_AI_PROVIDER,
    RERANK_AI_MODEL: process.env.RERANK_AI_MODEL,
    EXTRACTION_AI_PROVIDER: process.env.EXTRACTION_AI_PROVIDER,
    EXTRACTION_AI_MODEL: process.env.EXTRACTION_AI_MODEL,
    REVIEW_AI_PROVIDER: process.env.REVIEW_AI_PROVIDER,
    REVIEW_AI_MODEL: process.env.REVIEW_AI_MODEL,
    WRITING_AI_PROVIDER: process.env.WRITING_AI_PROVIDER,
    WRITING_AI_MODEL: process.env.WRITING_AI_MODEL,
    VERIFY_AI_PROVIDER: process.env.VERIFY_AI_PROVIDER,
    VERIFY_AI_MODEL: process.env.VERIFY_AI_MODEL,
    SUMMARY_CHECK_AI_PROVIDER: process.env.SUMMARY_CHECK_AI_PROVIDER,
    SUMMARY_CHECK_AI_MODEL: process.env.SUMMARY_CHECK_AI_MODEL,
    NOTE_CHECK_AI_PROVIDER: process.env.NOTE_CHECK_AI_PROVIDER,
    NOTE_CHECK_AI_MODEL: process.env.NOTE_CHECK_AI_MODEL,
    RELATED_CHECK_AI_PROVIDER: process.env.RELATED_CHECK_AI_PROVIDER,
    RELATED_CHECK_AI_MODEL: process.env.RELATED_CHECK_AI_MODEL,
    EMBEDDING_MODEL: process.env.EMBEDDING_MODEL,
    EMBEDDING_DIMENSIONS: process.env.EMBEDDING_DIMENSIONS,
  };
}

function pick(env: AiEnv, name: string): string | undefined {
  const value = env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

/** Pure resolver — tests pass their own env. */
export function resolveAiConfig(env: AiEnv): AiConfig {
  const problems: string[] = [];
  const stages = {} as Record<AiStage, StageConfig>;

  for (const stage of Object.keys(STAGE_ENV_PREFIX) as AiStage[]) {
    const prefix = STAGE_ENV_PREFIX[stage];
    const requestedProvider = (
      pick(env, `${prefix}_AI_PROVIDER`) || pick(env, "AI_PROVIDER") || "openai"
    ).toLowerCase();
    if (requestedProvider !== "openai") {
      const msg = `${prefix}_AI_PROVIDER/AI_PROVIDER="${requestedProvider}" is not supported; only "openai" is implemented`;
      if (!problems.includes(msg)) problems.push(msg);
    }
    stages[stage] = {
      stage,
      provider: "openai",
      model:
        pick(env, `${prefix}_AI_MODEL`) ||
        (FOLLOWS_REVIEW.includes(stage) ? pick(env, "REVIEW_AI_MODEL") : undefined) ||
        pick(env, "AI_MODEL") ||
        pick(env, "OPENAI_MODEL") ||
        DEFAULT_MODEL,
      timeoutMs: STAGE_TIMEOUT_MS[stage],
    };
  }

  const dimsRaw = pick(env, "EMBEDDING_DIMENSIONS");
  const dims = dimsRaw ? Number(dimsRaw) : DEFAULT_EMBEDDING_DIMENSIONS;
  const dimsValid = Number.isInteger(dims) && dims > 0;
  if (!dimsValid) {
    problems.push(`EMBEDDING_DIMENSIONS="${dimsRaw}" is not a positive integer`);
  }

  return {
    apiKey: pick(env, "OPENAI_API_KEY"),
    gatewayId: pick(env, "AI_GATEWAY_ID"),
    stages,
    embedding: {
      model: pick(env, "EMBEDDING_MODEL") || DEFAULT_EMBEDDING_MODEL,
      dimensions: dimsValid ? dims : DEFAULT_EMBEDDING_DIMENSIONS,
      timeoutMs: EMBEDDING_TIMEOUT_MS,
    },
    problems,
  };
}

let cached: AiConfig | null = null;
export function getAiConfig(): AiConfig {
  if (!cached) {
    cached = resolveAiConfig(readAiEnv());
    for (const problem of cached.problems) console.error(`[ai] config: ${problem}`);
  }
  return cached;
}

export function getStageConfig(stage: AiStage): StageConfig {
  return getAiConfig().stages[stage];
}

/** True when calls can actually be made (API key present, no unsupported provider requested). */
export function isAiConfigured(config: AiConfig = getAiConfig()): boolean {
  return !!(config.gatewayId || config.apiKey) && config.problems.length === 0;
}
