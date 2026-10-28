import { reactRouter } from "@react-router/dev/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "path";
import fs from "fs";

// Parse wrangler.toml [vars] so public values are available at build time
// without needing to duplicate them as Build Configuration env vars.
function loadWranglerVars(): Record<string, string> {
  try {
    const toml = fs.readFileSync(
      path.resolve(__dirname, "wrangler.toml"),
      "utf-8",
    );
    const vars: Record<string, string> = {};
    let inVars = false;
    for (const line of toml.split("\n")) {
      if (line.trim() === "[vars]") {
        inVars = true;
        continue;
      }
      if (inVars && line.trim().startsWith("[")) break;
      if (inVars) {
        const match = line.match(/^(\w+)\s*=\s*"(.*)"/);
        if (match) vars[match[1]] = match[2];
      }
    }
    return vars;
  } catch {
    return {};
  }
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load env vars from multiple sources (later entries take precedence):
  // 1. wrangler.toml [vars] — public values like Supabase URL, available at build time
  // 2. process.env — Cloudflare Builds injects build-time variables here
  // 3. Root .env — monorepo-level secrets (SUPABASE_SECRET_KEY, etc.)
  // 4. Local .env — app-level overrides
  const wranglerVars = loadWranglerVars();
  const rootEnv = loadEnv(mode, path.resolve(process.cwd(), "../../"), "");
  const localEnv = loadEnv(mode, process.cwd(), "");
  const env = { ...wranglerVars, ...process.env, ...rootEnv, ...localEnv };

  // Make all loaded environment variables available to the server-side
  // parts of the React Router dev server (loaders, actions).
  // This is crucial for server-side code to access secrets like SUPABASE_SECRET_KEY.
  Object.assign(process.env, env);

  return {
    server: {
      fs: {
        allow: [path.resolve(__dirname, "../..")],
      },
      // Extra dev hosts (tunnels, tailnet) come from the env, comma-separated.
      allowedHosts: (env.VITE_DEV_ALLOWED_HOSTS || "")
        .split(",")
        .map((host: string) => host.trim())
        .filter(Boolean),
    },
    plugins: [
      // CF_REMOTE_BINDINGS=false runs dev without a Wrangler login (AI calls then fail; pages render).
      cloudflare({ viteEnvironment: { name: "ssr" }, remoteBindings: process.env.CF_REMOTE_BINDINGS !== "false" }),
      tailwindcss(),
      reactRouter(),
      tsconfigPaths(),
    ],
    resolve: {
      alias: {
        "~": path.resolve(__dirname, "./app"),
      },
    },
    // Replace process.env.* references at build time so server code works
    // on Cloudflare Workers (where process.env doesn't exist).
    // Locally, Vite dev server already has these via Object.assign above.
    define: {
      "process.env.EMAIL_ALERTS_AVAILABLE": JSON.stringify(env.EMAIL_ALERTS_AVAILABLE ?? "false"),
      "process.env.PUBLIC_SIGNUP_LINKS": JSON.stringify(env.PUBLIC_SIGNUP_LINKS ?? "true"),
      "process.env.ENABLE_SIGNUPS": JSON.stringify(env.ENABLE_SIGNUPS ?? "true"),
      "process.env.SUPABASE_URL": JSON.stringify(env.SUPABASE_URL || ""),
      "process.env.SUPABASE_SECRET_KEY": JSON.stringify(
        env.SUPABASE_SECRET_KEY || "",
      ),
      "process.env.VITE_SUPABASE_URL": JSON.stringify(
        env.VITE_SUPABASE_URL || env.SUPABASE_URL || "",
      ),
      "process.env.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY": JSON.stringify(
        env.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY ||
          env.SUPABASE_PUBLISHABLE_DEFAULT_KEY ||
          "",
      ),
      "process.env.OPENAI_API_KEY": JSON.stringify(env.OPENAI_API_KEY || ""),
      "process.env.AI_USAGE_LOGGING": JSON.stringify(env.AI_USAGE_LOGGING || ""),
      "process.env.OPENAI_MODEL": JSON.stringify(env.OPENAI_MODEL || ""),
      "process.env.AI_PROVIDER": JSON.stringify(env.AI_PROVIDER || ""),
      "process.env.AI_GATEWAY_ID": JSON.stringify(env.AI_GATEWAY_ID || ""),
      "process.env.AI_MODEL": JSON.stringify(env.AI_MODEL || ""),
      "process.env.RAG_AI_PROVIDER": JSON.stringify(env.RAG_AI_PROVIDER || ""),
      "process.env.RAG_AI_MODEL": JSON.stringify(env.RAG_AI_MODEL || ""),
      "process.env.RERANK_AI_PROVIDER": JSON.stringify(env.RERANK_AI_PROVIDER || ""),
      "process.env.RERANK_AI_MODEL": JSON.stringify(env.RERANK_AI_MODEL || ""),
      "process.env.EXTRACTION_AI_PROVIDER": JSON.stringify(
        env.EXTRACTION_AI_PROVIDER || "",
      ),
      "process.env.EXTRACTION_AI_MODEL": JSON.stringify(
        env.EXTRACTION_AI_MODEL || "",
      ),
      "process.env.EMBEDDING_MODEL": JSON.stringify(env.EMBEDDING_MODEL || ""),
      "process.env.EMBEDDING_DIMENSIONS": JSON.stringify(
        env.EMBEDDING_DIMENSIONS || "",
      ),
      "process.env.VIMEO_TOKEN": JSON.stringify(env.VIMEO_TOKEN || ""),
      "process.env.VIMEO_PROXY_URL": JSON.stringify(env.VIMEO_PROXY_URL || ""),
      "process.env.VIMEO_PROXY_FALLBACK_URL": JSON.stringify(
        env.VIMEO_PROXY_FALLBACK_URL || "",
      ),
      "process.env.VIMEO_PROXY_API_KEY": JSON.stringify(
        env.VIMEO_PROXY_API_KEY || "",
      ),
      "process.env.VIMEO_PROXY_FALLBACK_API_KEY": JSON.stringify(
        env.VIMEO_PROXY_FALLBACK_API_KEY || "",
      ),
      "process.env.VITE_POSTHOG_KEY": JSON.stringify(
        env.VITE_POSTHOG_KEY || "",
      ),
      "process.env.DOCUMENT_IMAGE_PUBLIC_BASE_URL": JSON.stringify(
        env.DOCUMENT_IMAGE_PUBLIC_BASE_URL || "",
      ),
      "process.env.R2_PUBLIC_URL": JSON.stringify(env.R2_PUBLIC_URL || ""),
    },
  };
});
