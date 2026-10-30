// /api/og-image renders in workerd (Miniflare) with the same module types as production:
// .wasm as compiled modules, fonts as Data. Set OG_PREVIEW_DIR to also write the PNGs out.
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ogImageUrl, OG_VERSION } from "../../app/lib/og";
import { ogCardInput, titleSize } from "../../app/services/og/card";

const root = fileURLToPath(new URL("../../", import.meta.url));
let outdir: string;
let runtime: Miniflare;

const portrait = readFileSync(path.join(root, "public/images/council/mark-morley.jpg"));

beforeAll(async () => {
  outdir = mkdtempSync(path.join(tmpdir(), "og-image-test-"));
  await build({
    stdin: {
      contents: `import { loader } from "./app/routes/api.og-image";
        const waits = [];
        export default { async fetch(request, env, ctx) {
          const url = new URL(request.url);
          if (url.pathname === "/__kv") return new Response(String((await env.PUBLIC_CACHE.list()).keys.length));
          return loader({ request, context: { cloudflare: { env, ctx } } });
        } };`,
      resolveDir: root,
      loader: "ts",
    },
    bundle: true, format: "esm", platform: "browser", target: "es2022", jsx: "automatic",
    conditions: ["workerd", "worker", "browser"],
    outfile: path.join(outdir, "worker.js"),
    loader: { ".wasm": "copy", ".bin": "copy" },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  runtime = new Miniflare({
    workers: [{
      name: "og", modules: true, compatibilityDate: "2026-02-10", compatibilityFlags: ["nodejs_compat"],
      scriptPath: path.join(outdir, "worker.js"), modulesRoot: outdir,
      modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm"] }, { type: "Data", include: ["**/*.bin"] }],
      kvNamespaces: ["PUBLIC_CACHE"],
      serviceBindings: {
        ASSETS: async (request: Request) => new URL(request.url).pathname === "/images/council/mark-morley.jpg"
          ? new Response(portrait, { headers: { "Content-Type": "image/jpeg" } })
          : new Response("Not found", { status: 404 }),
      },
    }],
  });
}, 60_000);

afterAll(async () => {
  await runtime?.dispose();
  if (outdir) rmSync(outdir, { recursive: true, force: true });
});

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

async function fetchCard(url: string, name?: string) {
  const local = url.replace("https://openlangford.ca", "https://og.test");
  const response = await runtime.dispatchFetch(local);
  const body = new Uint8Array(await response.arrayBuffer());
  if (name && process.env.OG_PREVIEW_DIR && response.status === 200) {
    mkdirSync(process.env.OG_PREVIEW_DIR, { recursive: true });
    writeFileSync(path.join(process.env.OG_PREVIEW_DIR, `${name}.png`), body);
  }
  return { response, body };
}

describe("/api/og-image", () => {
  const cases: [string, string][] = [
    ["about", ogImageUrl("About Open Langford", { subtitle: "Independent, plain-language records of Langford council meetings" })],
    ["person", ogImageUrl("Mark Morley", { subtitle: "Councillor, 2022–present", type: "person", image: "/images/council/mark-morley.jpg" })],
    ["decision", ogImageUrl("Rezoning for 47 homes on Latoria Road", { subtitle: "Council approved the rezoning in May 2026", type: "decision" })],
    ["escaping", ogImageUrl(`<script>alert("x")</script> & 'quotes' — Szőke Café`, { subtitle: "</div><img src=x onerror=alert(1)>", type: "bylaw" })],
    ["long-title", ogImageUrl("A very long title ".repeat(20), { subtitle: "And a long subtitle that keeps going ".repeat(10), type: "property" })],
  ];

  it.each(cases)("renders a non-empty 1200×630 PNG (%s)", async (name, url) => {
    const { response, body } = await fetchCard(url, name);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toContain("immutable");
    expect(body.byteLength).toBeGreaterThan(5_000);
    expect(pngSize(body)).toEqual({ width: 1200, height: 630 });
  }, 30_000);

  it("serves repeats from cache and stores versioned renders in KV", async () => {
    const url = ogImageUrl("Cached card", { type: "election" });
    const first = await fetchCard(url);
    expect(first.response.headers.get("X-Og-Cache")).toBe("miss");
    const again = await fetchCard(url);
    expect(again.response.headers.get("X-Og-Cache")).toBe("hit");
    expect(again.body).toEqual(first.body);
    const kv = await runtime.dispatchFetch("https://og.test/__kv");
    expect(Number(await kv.text())).toBeGreaterThan(0);
  }, 30_000);

  it("still renders old unversioned URLs, with a short cache", async () => {
    const { response, body } = await fetchCard("https://og.test/api/og-image?title=About+Open+Langford&type=matter");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=86400");
    expect(pngSize(body)).toEqual({ width: 1200, height: 630 });
  }, 30_000);

  it("renders without a portrait that is missing", async () => {
    const { response, body } = await fetchCard(ogImageUrl("Nobody", { type: "person", image: "/images/council/nobody.jpg" }));
    expect(response.status).toBe(200);
    expect(body.byteLength).toBeGreaterThan(5_000);
  }, 30_000);
});

describe("share image URLs", () => {
  it("carry the design version and clip long text", () => {
    const url = new URL(ogImageUrl("x".repeat(500), { subtitle: "word ".repeat(200), type: "bylaw" }));
    expect(url.searchParams.get("v")).toBe(OG_VERSION);
    expect(url.searchParams.get("title")!.length).toBeLessThanOrEqual(140);
    expect(url.searchParams.get("subtitle")!.length).toBeLessThanOrEqual(200);
  });

  it("only accepts site portraits", () => {
    const input = (image: string) => ogCardInput(new URLSearchParams({ title: "t", image })).imagePath;
    expect(input("/images/council/mark-morley.jpg")).toBe("/images/council/mark-morley.jpg");
    expect(input("https://evil.example/x.jpg")).toBeUndefined();
    expect(input("/images/../secret.jpg")).toBeUndefined();
    expect(input("//evil.example/images/x.jpg")).toBeUndefined();
  });

  it("labels decisions in plain words, including old 'matter' URLs", () => {
    expect(ogCardInput(new URLSearchParams({ title: "t", type: "matter" })).label).toBe("Council decision");
    expect(ogCardInput(new URLSearchParams({ title: "t", type: "nonsense" })).label).toBe("");
  });

  it("has a JPEG copy of every council portrait (share cards can't read WebP)", () => {
    const dir = path.join(root, "public/images/council");
    const missing = readdirSync(dir).filter((f) => f.endsWith(".webp") && !existsSync(path.join(dir, f.replace(/\.webp$/, ".jpg"))));
    expect(missing, "run: sips -s format jpeg -s formatOptions 82 x.webp --out x.jpg").toEqual([]);
  });

  it("steps the title size down for long titles", () => {
    expect(titleSize("Short", false)).toBeGreaterThan(titleSize("x".repeat(120), false));
  });
});
