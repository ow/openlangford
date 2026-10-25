import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rows: {} as Record<string, any[]>, errorTable: "", reads: [] as string[] }));
vi.mock("../../app/lib/supabase.server", () => ({
  getSupabaseAdminClient: () => { throw new Error("Markdown must not use admin access"); },
  createSupabaseServerClient: () => { throw new Error("Markdown must not use user sessions"); },
  getSupabasePublicClient: () => ({ from: (table: string) => {
    state.reads.push(table);
    let rows = [...(state.rows[table] || [])];
    const result = () => ({ data: rows, error: state.errorTable === table ? new Error("Database unavailable") : null });
    const q: any = {
      select: () => q,
      eq: (key: string, value: unknown) => { rows = rows.filter(r => String(r[key]) === String(value)); return q; },
      or: () => { rows = rows.filter(r => r.has_agenda || r.has_minutes || r.has_transcript || r.summary != null); return q; },
      order: (key: string) => { rows.sort((a, b) => a[key] - b[key]); return q; },
      limit: (count: number) => { rows = rows.slice(0, count); return q; },
      maybeSingle: async () => ({ ...result(), data: rows[0] || null }),
      then: (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject),
    }; return q;
  } }),
}));
import { loader as meetingLoader } from "../../app/routes/meeting-markdown";
import { loader as documentLoader } from "../../app/routes/document-markdown";
const slug = "2026-05-19-regular-council";
const base = `https://openlangford.ca/meetings/${slug}`;
const load = (doc = false, url = `${base}${doc ? "/documents/8/content.md" : "/summary.md"}`, cookie = "") =>
  (doc ? documentLoader : meetingLoader)({ request: new Request(url, { headers: { Cookie: cookie } }), params: { id: slug, ...(doc ? { docId: "8" } : {}) } } as any);
beforeEach(() => {
  state.errorTable = ""; state.reads = [];
  state.rows = {
    meetings: [{ id: 1, municipality_id: 1, slug, title: "Regular Council", meeting_date: "2026-05-19", summary: "Existing summary", has_minutes: true, minutes_url: "https://langford.ca/minutes.pdf", updated_at: "2026-05-20T12:00:00Z", meta: { private: "secret" } }],
    documents: [{ id: 3, meeting_id: 1, title: "Staff report", source_url: "https://langford.ca/report.pdf" }],
    extracted_documents: [{ id: 8, document_id: 3, title: "Report", summary: "Existing report summary", page_start: 2, page_end: 4 }],
    document_sections: [{ extracted_document_id: 8, section_title: "Second", section_order: 2, section_text: "Later text", page_start: 4, page_end: 4 }, { extracted_document_id: 8, section_title: "First", section_order: 1, section_text: "Earlier text", page_start: 2, page_end: 3 }],
  };
});
it("serves a dated overview with provenance, canonical and public cache headers", async () => {
  const res = await load(); const body = await res.text();
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
  expect(res.headers.get("X-Robots-Tag")).toBe("noindex, follow");
  expect(res.headers.get("Link")).toBe(`<${base}>; rel="canonical"`);
  expect(res.headers.get("Cache-Control")).toContain("s-maxage=300");
  expect(body).toContain("May 19, 2026"); expect(body).toContain("Existing summary");
  expect(body).toContain("https://langford.ca/minutes.pdf");
  expect(body).toContain("AI-processed"); expect(body).not.toContain("secret");
  expect(res.headers.has("Set-Cookie")).toBe(false);
});
it("returns the same representation for authenticated requests without setting cookies", async () => {
  expect(await (await load(false, undefined, "sb-auth-token=private-user-session")).text()).toBe(await (await load()).text());
});
it("serves ordered document text and source pages for its own meeting", async () => {
  const res = await load(true); const body = await res.text();
  expect(res.status).toBe(200); expect(body.indexOf("Earlier text")).toBeLessThan(body.indexOf("Later text"));
  expect(body).toContain("https://langford.ca/report.pdf"); expect(body).toContain("Source pages: 2–4");
  expect(res.headers.get("Link")).toBe(`<${base}/documents/8>; rel="canonical"`);
});
it.each(["unknown", "unready", "other-municipality", "wrong-parent"])("rejects %s records without caching", async kind => {
  if (kind === "unknown") state.rows.meetings = [];
  if (kind === "unready") Object.assign(state.rows.meetings[0], { summary: null, has_minutes: false });
  if (kind === "other-municipality") state.rows.meetings[0].municipality_id = 2;
  if (kind === "wrong-parent") state.rows.documents[0].meeting_id = 99;
  const res = await load(true);
  expect(res.status).toBe(404); expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(state.reads).not.toContain("document_sections");
});
it("reports failed reads as uncached 503 rather than incomplete success or false 404", async () => {
  state.errorTable = "document_sections";
  const res = await load(true);
  expect(res.status).toBe(503); expect(res.headers.get("Cache-Control")).toBe("no-store");
});
it("does not read records for invalid/private parameter paths", async () => {
  const res = await meetingLoader({ request: new Request(base + "/summary.md"), params: { id: "../settings" } } as any);
  expect(res.status).toBe(404); expect(state.reads).toEqual([]);
});
it("redirects legacy numeric meeting URLs to the Markdown slug URL", async () => {
  const res = await meetingLoader({ request: new Request("https://openlangford.ca/meetings/1/summary.md"), params: { id: "1" } } as any);
  expect(res.status).toBe(301); expect(res.headers.get("Location")).toBe(base + "/summary.md");
});
it("bounds large document representations and marks omissions", async () => {
  state.rows.document_sections = Array.from({ length: 502 }, (_, i) => ({ extracted_document_id: 8, section_order: i, section_text: `Text number ${i}.` }));
  const body = await (await load(true)).text();
  expect(body).toContain("Text number 499."); expect(body).not.toContain("Text number 500.");
  expect(body).toContain("limited to 500 sections");
});
it("returns an empty successful HEAD with the same public headers", async () => {
  const res = await meetingLoader({ request: new Request(base + "/summary.md", { method: "HEAD" }), params: { id: slug } } as any);
  expect(res.status).toBe(200); expect(await res.text()).toBe("");
  expect(res.headers.get("Link")).toBe(`<${base}>; rel="canonical"`);
});
it("bounds a long source-document list and explains the limit", async () => {
  state.rows.documents = Array.from({ length: 202 }, (_, i) => ({ id: i, meeting_id: 1, title: `Source ${i}.`, source_url: `https://langford.ca/${i}.pdf` }));
  const body = await (await load()).text();
  expect(body).toContain("Source 199."); expect(body).not.toContain("Source 200.");
  expect(body).toContain("limited to 200 entries");
});
it.each([false, true])("301s a renamed meeting slug to the current markdown URL (doc=%s)", async doc => {
  const old = "2026-05-20-regular-council";
  state.rows.meeting_slug_history = [{ meeting_id: 1, old_slug: old }];
  const request = new Request(`https://openlangford.ca/meetings/${old}${doc ? "/documents/8/content.md" : "/summary.md"}`);
  const res = await (doc ? documentLoader : meetingLoader)({ request, params: { id: old, ...(doc ? { docId: "8" } : {}) } } as any);
  expect(res.status).toBe(301);
  expect(res.headers.get("Location")).toBe(`${base}${doc ? "/documents/8/content.md" : "/summary.md"}`);
});
