import { beforeEach, expect, it, vi } from "vitest";
import { nextCheckedPath, precheckState } from "~/services/page-precheck.server";
import { sitemapEntries } from "~/services/sitemap.server";

vi.mock("~/services/page-check.server", () => ({ checkPage: vi.fn() }));
vi.mock("~/services/sitemap.server", () => ({
  SITEMAP_SECTIONS: ["pages", "matters", "meetings", "documents", "properties"],
  sitemapEntries: vi.fn(),
}));

type Row = { path: string; status: string | null; check_requested_at: string | null; ai_checked_at: string | null };
const checked = (path: string, status: string | null = null): Row => ({ path, status, check_requested_at: null, ai_checked_at: "2026-11-03" });
// In-memory query adapter: exercise filtering and pagination against stored rows, without live records or AI.
function database(rows: Row[]) {
  return { from: () => {
    let selected = [...rows], head = false;
    const query: any = {
      select: (_: string, options?: { head?: boolean }) => { head = !!options?.head; return query; },
      is: (key: keyof Row, value: null) => { selected = selected.filter((row) => row[key] === value); return query; },
      not: (key: keyof Row, _: string, value: null) => { selected = selected.filter((row) => row[key] !== value); return query; },
      order: () => query,
      range: (from: number, to: number) => Promise.resolve({ data: selected.slice(from, to + 1), error: null }),
      then: (resolve: any) => Promise.resolve({ data: head ? null : selected, count: selected.length, error: null }).then(resolve),
    };
    return query;
  } } as any;
}

beforeEach(() => { vi.mocked(sitemapEntries).mockReset(); });

it("drains the checked queue without revisiting merged aliases of an already-reviewed page", async () => {
  const old = "/matters/design-guidelines-for-carriage-houses";
  const canonical = "/matters/carriage-house-design-guidelines-and-separation-requirements";
  const next = "/matters/another-topic";
  const rows = [checked(old), checked(canonical, "reviewed"), checked(next), checked("/matters/hidden-topic")];
  vi.mocked(sitemapEntries).mockResolvedValue([{ path: canonical }, { path: next }] as any);
  const db = database(rows);
  expect(await precheckState(db)).toEqual({ queued: 0, ready: 1 });
  expect(await nextCheckedPath(db, null)).toBe(next);
  expect(await nextCheckedPath(db, next)).toBeNull();
  rows[2].status = "reviewed";
  expect(await precheckState(db)).toEqual({ queued: 0, ready: 0 });
  expect(await nextCheckedPath(db, null)).toBeNull();
  expect(rows[0]).toEqual(checked(old)); // retain the historical review, not a data cleanup
});

it("keeps current reviewable detail pages and excludes indexes, reviewed and queued pages", async () => {
  const paths = ["/matters", "/meetings/a-meeting", "/properties/a-home"];
  vi.mocked(sitemapEntries).mockImplementation(async (_, section) =>
    paths.filter((path) => section === "pages" ? path === "/matters" : path.startsWith(`/${section}/`)).map((path) => ({ path })) as any);
  const db = database([...paths.map((p) => checked(p)), checked("/matters/reviewed", "reviewed"),
    { ...checked("/matters/queued"), check_requested_at: "2026-11-12" }, { ...checked("/matters/unchecked"), ai_checked_at: null }]);
  expect(await precheckState(db)).toEqual({ queued: 1, ready: 2 });
  expect(await nextCheckedPath(db, "/matters")).toBe("/meetings/a-meeting");
});

it("can reach a current page beyond a full batch of retired paths", async () => {
  const current = "/matters/current";
  vi.mocked(sitemapEntries).mockResolvedValue([{ path: current }] as any);
  const db = database([...Array.from({ length: 1000 }, (_, i) => checked(`/matters/retired-${i}`)), checked(current)]);
  expect(await nextCheckedPath(db, null)).toBe(current);
  expect((await precheckState(db)).ready).toBe(1);
});

it("does not report a finished queue when the public inventory fails", async () => {
  vi.mocked(sitemapEntries).mockRejectedValue(new Error("inventory unavailable"));
  await expect(precheckState(database([checked("/matters/current")]))).rejects.toThrow("inventory unavailable");
});
