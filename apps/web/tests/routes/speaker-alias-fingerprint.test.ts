import { beforeEach, expect, it, vi } from "vitest";

type Op = [string, any[]];
type Call = { table: string; ops: Op[] };

/** Chainable Supabase stand-in: records each query, answers from `respond(table, ops)`. */
function fakeAdmin(respond: (table: string, ops: Op[]) => { data: any; error: any }) {
  const calls: Call[] = [];
  return {
    calls,
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const builder: any = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === "then") {
            return (resolve: any, reject: any) => Promise.resolve(respond(table, call.ops)).then(resolve, reject);
          }
          return (...args: any[]) => {
            call.ops.push([prop, args]);
            return builder;
          };
        },
      });
      return builder;
    },
  };
}

const mocks = vi.hoisted(() => ({ admin: null as any }));
vi.mock("~/lib/auth.server", () => ({ requireAdmin: vi.fn(async () => ({ id: "admin" })) }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabaseAdminClient: () => mocks.admin,
  createSupabaseServerClient: () => ({ supabase: {}, headers: new Headers() }),
}));

import { action } from "~/routes/speaker-alias";
import { mayStoreVoiceFingerprint } from "~/services/voice-fingerprint-policy.server";

const CENTROID = JSON.stringify(Array.from({ length: 192 }, (_, i) => i / 192));

/** People: 1 councillor, 2 staff member, 3 on this meeting's roster, 4 a resident; 99 is created. */
function world({ failLookups = false } = {}) {
  return fakeAdmin((table, ops) => {
    const eq = (col: string) => ops.find(([op, args]) => op === "eq" && args[0] === col)?.[1][1];
    if (failLookups && ["people", "memberships", "attendance"].includes(table) && ops[0]?.[0] === "select") {
      return { data: null, error: { message: "offline" } };
    }
    if (table === "people" && ops[0][0] === "insert") return { data: { id: 99 }, error: null };
    if (table === "people" && ops[0][0] === "select") {
      const id = Number(eq("id"));
      return { data: [1, 2, 3, 4, 99].includes(id) ? { id, is_councillor: id === 1 } : null, error: null };
    }
    if (table === "memberships") return { data: Number(eq("person_id")) === 2 ? [{ id: 5 }] : [], error: null };
    if (table === "attendance") return { data: Number(eq("person_id")) === 3 && Number(eq("meeting_id")) === 42 ? [{ id: 6 }] : [], error: null };
    if (table === "voice_fingerprints" && ops[0][0] === "select") return { data: null, error: null };
    if (table === "voice_fingerprints" && ops[0][0] === "insert") return { data: { id: 700 }, error: null };
    return { data: null, error: null };
  });
}

function assign(fields: Record<string, string>) {
  const body = new URLSearchParams({ intent: "assign_alias", meetingId: "42", speakerLabel: "SPEAKER_03", centroid: CENTROID, ...fields });
  return action({ request: new Request("https://openlangford.ca/speaker-alias", { method: "POST", body }) });
}

const fingerprintWrites = () =>
  (mocks.admin.calls as Call[]).filter((c) => c.table === "voice_fingerprints" && c.ops.some(([op]) => ["insert", "update", "upsert"].includes(op)));
const aliasWrites = () => (mocks.admin.calls as Call[]).filter((c) => c.table === "meeting_speaker_aliases");

beforeEach(() => {
  mocks.admin = world();
});

it.each([
  ["a councillor", "1"],
  ["a staff member", "2"],
  ["someone on this meeting's attendance roster", "3"],
])("stores a voice fingerprint for %s", async (_who, personId) => {
  expect(await assign({ personId })).toEqual({ success: true });
  expect(aliasWrites()).toHaveLength(1);
  expect(fingerprintWrites()).toHaveLength(1);
  expect(fingerprintWrites()[0].ops[0][1][0]).toMatchObject({ person_id: personId, source_meeting_id: "42" });
});

it("names a resident on the transcript without storing their voice", async () => {
  expect(await assign({ personId: "4" })).toEqual({ success: true, fingerprint: "skipped" });
  expect(aliasWrites()).toHaveLength(1);
  expect((mocks.admin.calls as Call[]).some((c) => c.table === "transcript_segments")).toBe(true);
  expect(fingerprintWrites()).toEqual([]);
});

it("never stores a voice for a newly created person", async () => {
  expect(await assign({ newPersonName: "A Resident" })).toEqual({ success: true, fingerprint: "skipped" });
  expect(aliasWrites()).toHaveLength(1);
  expect(fingerprintWrites()).toEqual([]);
});

it("fails closed when the official lookup fails", async () => {
  mocks.admin = world({ failLookups: true });
  expect(await mayStoreVoiceFingerprint(mocks.admin, 1, 42)).toBe(false);
});

it("only counts a roster entry for the same meeting", async () => {
  expect(await mayStoreVoiceFingerprint(mocks.admin, 3, 41)).toBe(false);
  expect(await mayStoreVoiceFingerprint(mocks.admin, 3, 42)).toBe(true);
});
