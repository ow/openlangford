import { describe, expect, it } from "vitest";
import { findMeetingBySlugHistory, resolveSlugParam } from "~/lib/slug-params.server";
import { meetingDocumentsPath, meetingPath, documentPath } from "~/lib/paths";

type Row = Record<string, any>;
/** Minimal supabase stand-in: select/eq/limit/maybeSingle over in-memory tables. */
function fakeSupabase(tables: Record<string, Row[]>) {
  return {
    from(name: string) {
      let rows = [...(tables[name] ?? [])];
      const q: any = {
        select: () => q,
        eq: (col: string, val: unknown) => { rows = rows.filter((r) => r[col] === val); return q; },
        limit: () => q,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      };
      return q;
    },
  } as any;
}

const tables = {
  meetings: [{ id: 173, slug: "2022-11-21-special-council" }, { id: 172, slug: "2024-12-16-special-council-2" }],
  meeting_slug_history: [
    { meeting_id: 173, old_slug: "2022-11-22-special-council" },
    { meeting_id: 172, old_slug: "2024-12-17-special-council" },
  ],
};
const req = (path: string) => new Request(`https://openlangford.ca${path}`);

async function redirectOf(fn: () => Promise<unknown>): Promise<{ status: number; location: string }> {
  try { await fn(); } catch (e) {
    if (e instanceof Response) return { status: e.status, location: e.headers.get("Location")! };
    throw e;
  }
  throw new Error("expected a redirect");
}

describe("meeting slug history redirects", () => {
  const db = fakeSupabase(tables);
  const old = "2022-11-22-special-council";

  it("301s a renamed slug to the current meeting URL, keeping the query string", async () => {
    const r = await redirectOf(() => resolveSlugParam(db, "meetings", old, req(`/meetings/${old}?t=120`), (m) => meetingPath(m)));
    expect(r).toEqual({ status: 301, location: "/meetings/2022-11-21-special-council?t=120" });
  });

  it.each([
    ["explorer", (m: any) => meetingPath(m, "/explorer"), "/explorer"],
    ["documents", (m: any) => meetingDocumentsPath(m), "/documents"],
    ["document viewer", (m: any) => documentPath(m, 77), "/documents/77"],
  ])("keeps the sub-path for the %s route", async (_n, build, suffix) => {
    const r = await redirectOf(() => resolveSlugParam(db, "meetings", old, req(`/meetings/${old}${suffix}`), build));
    expect(r.status).toBe(301);
    expect(r.location).toBe(`/meetings/2022-11-21-special-council${suffix}`);
  });

  it("returns the row instead of redirecting when redirectLegacy is false", async () => {
    const row = await resolveSlugParam(db, "meetings", old, req("/x"), (m) => meetingPath(m), "nf", { redirectLegacy: false });
    expect(row).toEqual({ id: 173, slug: "2022-11-21-special-council" });
  });

  it("serves the current slug directly and 404s unknown slugs", async () => {
    const row = await resolveSlugParam(db, "meetings", "2022-11-21-special-council", req("/x"), (m) => meetingPath(m));
    expect(row.id).toBe(173);
    await expect(resolveSlugParam(db, "meetings", "1999-01-01-nope", req("/x"), (m) => meetingPath(m))).rejects.toMatchObject({ status: 404 });
  });

  it("does not consult history for other tables", async () => {
    await expect(resolveSlugParam(db, "matters", old, req("/x"), (m) => `/matters/${m.slug}`)).rejects.toMatchObject({ status: 404 });
  });

  it("findMeetingBySlugHistory ignores a history row that already equals the live slug", async () => {
    const same = fakeSupabase({ meetings: [{ id: 5, slug: "a" }], meeting_slug_history: [{ meeting_id: 5, old_slug: "a" }] });
    expect(await findMeetingBySlugHistory(same, "a")).toBeNull();
  });
});
