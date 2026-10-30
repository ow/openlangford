import { expect, it, vi } from "vitest";
import { applyPrivacyRetention, purgeExpiredQuestions } from "../../workers/retention";

function fakeClient(result: { count: number | null; error: { message: string } | null }) {
  const calls: Array<{ table: string; column: string; value: string; opts: unknown }> = [];
  const client = {
    from: (table: string) => ({
      delete: (opts: unknown) => ({
        lt: async (column: string, value: string) => {
          calls.push({ table, column, value, opts });
          return result;
        },
      }),
    }),
  };
  return { client: client as any, calls };
}

it("deletes expired shared answers and question traces older than 30 days", async () => {
  const { client, calls } = fakeClient({ count: 3, error: null });
  const summary = await purgeExpiredQuestions(client, new Date("2026-10-30T12:00:00Z"));
  expect(summary).toEqual({ expiredAnswers: 3, oldTraces: 3 });
  expect(calls).toEqual([
    { table: "search_results_cache", column: "expires_at", value: "2026-10-30T12:00:00.000Z", opts: { count: "exact" } },
    { table: "rag_traces", column: "created_at", value: "2026-09-30T12:00:00.000Z", opts: { count: "exact" } },
  ]);
});

it("reports a failed purge so the cron logs it", async () => {
  const { client } = fakeClient({ count: null, error: { message: "offline" } });
  await expect(purgeExpiredQuestions(client)).rejects.toThrow("offline");
});

it("runs the 12-month contact and email retention through the database function", async () => {
  const summary = { dry_run: false, contact_messages_deleted: 2, email_messages_anonymized: 5 };
  const rpc = vi.fn().mockResolvedValue({ data: summary, error: null });
  expect(await applyPrivacyRetention({ rpc } as any)).toEqual(summary);
  expect(rpc).toHaveBeenCalledWith("apply_privacy_retention", { p_dry_run: false });
  rpc.mockResolvedValue({ data: null, error: { message: "offline" } });
  await expect(applyPrivacyRetention({ rpc } as any)).rejects.toThrow("offline");
});
