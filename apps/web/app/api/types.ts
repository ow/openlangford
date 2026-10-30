/// <reference types="@cloudflare/workers-types" />

export interface ApiEnv {
  Bindings: {
    VITE_SUPABASE_URL: string;
    VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY: string;
    SUPABASE_SECRET_KEY: string;
    OPENAI_API_KEY: string;
    OPENAI_MODEL?: string;
    AI_PROVIDER?: string;
    AI_MODEL?: string;
    RAG_AI_PROVIDER?: string;
    RAG_AI_MODEL?: string;
    RERANK_AI_PROVIDER?: string;
    RERANK_AI_MODEL?: string;
    EXTRACTION_AI_PROVIDER?: string;
    EXTRACTION_AI_MODEL?: string;
    API_RATE_LIMITER: RateLimit;
    [key: string]: unknown;
  };
  Variables: {
    requestId: string;
    apiKeyId?: string;
    userId?: string;
    municipality?: {
      id: string;
      slug: string;
      name: string;
      short_name: string;
      ocd_id: string | null;
      meta?: Record<string, unknown> | null;
    };
  };
}
