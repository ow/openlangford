import { describe, expect, it } from "vitest";
import { getAudiencePage } from "../../app/services/audience-admin.server";

const user = (i: number) => ({ id: `id-${i}`, email: `person${i}@example.com`, created_at: "2026-11-01T00:00:00Z", user_metadata: {} });

function fakeClient(users: any[], perPageSeen: number[] = []) {
  return {
    auth: { admin: { listUsers: async ({ page, perPage }: { page: number; perPage: number }) => {
      perPageSeen.push(perPage);
      const slice = users.slice((page - 1) * perPage, page * perPage);
      return { data: { users: slice, nextPage: page * perPage < users.length ? page + 1 : null, lastPage: Math.ceil(users.length / perPage), total: users.length }, error: null };
    } } },
    from: (table: string) => ({
      select: () => {
        const q: any = { in: async () => ({ data: table === "user_profiles" ? [] : [], error: null }), eq: () => q, then: undefined };
        q.eq = () => ({ eq: async () => ({ count: 0, error: null }) });
        return q;
      },
    }),
  } as any;
}

describe("account search", () => {
  it("finds an exact email that isn't on the first page", async () => {
    const users = Array.from({ length: 31 }, (_, i) => user(i + 1));
    const result = await getAudiencePage(fakeClient(users), 1, "person31@example.com");
    expect(result.users.map((u) => u.email)).toEqual(["person31@example.com"]);
    expect(result.total).toBe(1);
    expect(result.hasMore).toBe(false);
  });
  it("still pages normally without a search", async () => {
    const users = Array.from({ length: 31 }, (_, i) => user(i + 1));
    const result = await getAudiencePage(fakeClient(users), 2, "");
    expect(result.users).toHaveLength(6);
    expect(result.total).toBe(31);
  });
});
