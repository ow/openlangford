import type { Route } from "./+types/admin-users";
import { Link } from "react-router";
import {
  adminRead,
  adminReadOnlyAction,
  boundedPage,
  privateAdminHeaders,
} from "../lib/admin-read.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { getAudiencePage } from "../services/audience-admin.server";
import {
  AdminAudienceLayout,
  AdminFilter,
  AdminPagination,
  adminCard,
  adminDate,
  adminField,
  adminLink,
} from "../components/admin/audience-layout";

export const meta = () => [
  { title: "Users | Admin | Open Langford" },
  { name: "robots", content: "noindex, nofollow" },
];
export const headers = privateAdminHeaders;
export const action = adminReadOnlyAction;
export async function loader({ request }: Route.LoaderArgs) {
  return adminRead(request, async () => {
    const url = new URL(request.url),
      page = boundedPage(url.searchParams.get("page"));
    const q = (url.searchParams.get("q") || "").trim().slice(0, 80);
    return {
      ...(await getAudiencePage(getSupabaseAdminClient(), page, q)),
      page,
      q,
    };
  });
}
export default function AdminUsers({ loaderData }: Route.ComponentProps) {
  const { users, page, q, hasMore, total } = loaderData;
  return (
    <AdminAudienceLayout
      title="Users"
      description="Registered accounts, confirmation and saved preferences."
    >
      <AdminFilter>
        <input type="hidden" name="page" value={page} />
        <label className="grid gap-1 text-sm">
          Filter this page
          <input
            className={adminField}
            name="q"
            defaultValue={q}
            maxLength={80}
            placeholder="Email or display name"
          />
        </label>
        <Link
          className={`${adminLink} py-2 text-sm`}
          to={`/admin/users?page=${page}`}
        >
          Clear
        </Link>
      </AdminFilter>
      <p className="mb-4 text-sm text-zinc-500">
        {total == null ? "Accounts" : `${total} accounts`} · Up to 25 per page.
        Filtering applies to this page only; use Next to browse more accounts.
      </p>
      <div className={`${adminCard} overflow-x-auto p-0`}>
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-100 text-xs text-zinc-600">
            <tr>
              {[
                "Account",
                "Email confirmation",
                "Joined / last sign-in",
                "Onboarding",
                "Active subscriptions",
              ].map((label) => (
                <th className="px-4 py-3" scope="col" key={label}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {users.map((user) => (
              <tr key={user.id}>
                <td className="px-4 py-4">
                  <Link className={adminLink} to={`/admin/users/${user.id}`}>
                    {user.name || user.email || "Unnamed account"}
                  </Link>
                  <p className="mt-1 text-xs text-zinc-500">
                    {user.email || "No email"}
                  </p>
                </td>
                <td className="px-4 py-4">
                  {user.confirmedAt ? "Confirmed" : "Pending"}
                </td>
                <td className="px-4 py-4 text-xs leading-6 text-zinc-600">
                  {adminDate(user.createdAt)}
                  <br />
                  {user.lastSignInAt
                    ? adminDate(user.lastSignInAt)
                    : "Never signed in"}
                </td>
                <td className="px-4 py-4">
                  {!user.hasProfile
                    ? "No profile yet"
                    : user.onboardingCompleted
                      ? "Complete"
                      : "Incomplete"}
                </td>
                <td className="px-4 py-4 tabular-nums">
                  {user.subscriptionCount}
                </td>
              </tr>
            ))}
            {!users.length && (
              <tr>
                <td
                  className="px-4 py-10 text-center text-zinc-500"
                  colSpan={5}
                >
                  {q
                    ? "No matching accounts on this page."
                    : "No accounts on this page."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <AdminPagination page={page} hasMore={hasMore} label="Account pages" />
    </AdminAudienceLayout>
  );
}
