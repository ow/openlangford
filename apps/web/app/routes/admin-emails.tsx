import type { Route } from "./+types/admin-emails";
import { Link } from "react-router";
import {
  adminRead,
  adminReadOnlyAction,
  privateAdminHeaders,
} from "../lib/admin-read.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { EMAIL_STATUSES, EMAIL_TYPES } from "../lib/email-ledger";
import { emailFilters, getEmailPage } from "../services/email-admin.server";
import {
  AdminAudienceLayout,
  AdminFilter,
  AdminPagination,
  LedgerCoverage,
  adminCard,
  adminDate,
  adminField,
  adminLink,
} from "../components/admin/audience-layout";

export const meta = () => [
  { title: "Email activity | Admin | Open Langford" },
  { name: "robots", content: "noindex, nofollow" },
];
export const headers = privateAdminHeaders;
export const action = adminReadOnlyAction;
export async function loader({ request }: Route.LoaderArgs) {
  return adminRead(request, async () => {
    const filters = emailFilters(new URL(request.url));
    return {
      ...(await getEmailPage(getSupabaseAdminClient(), filters)),
      filters,
    };
  });
}
export default function AdminEmails({ loaderData }: Route.ComponentProps) {
  const { available, messages, hasMore, total, filters } = loaderData;
  return (
    <AdminAudienceLayout
      title="Email activity"
      description="Application alerts: recorded attempts and provider delivery events."
    >
      <LedgerCoverage available={available} />
      {filters.user && (
        <p className="mb-4 text-sm">
          Filtered to one account.{" "}
          <Link className={adminLink} to={`/admin/users/${filters.user}`}>
            View user
          </Link>{" "}
          ·{" "}
          <Link className={adminLink} to="/admin/emails">
            All accounts
          </Link>
        </p>
      )}
      <AdminFilter>
        {filters.user && (
          <input type="hidden" name="user" value={filters.user} />
        )}
        <label className="grid gap-1 text-sm">
          Recipient
          <input
            name="q"
            maxLength={120}
            className={adminField}
            defaultValue={filters.recipient}
            placeholder="Email contains…"
          />
        </label>
        <label className="grid gap-1 text-sm">
          Status
          <select
            name="status"
            className={adminField}
            defaultValue={filters.status}
          >
            <option value="">All statuses</option>
            {EMAIL_STATUSES.map((status) => (
              <option key={status}>{status}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Type
          <select
            name="type"
            className={adminField}
            defaultValue={filters.type}
          >
            <option value="">All alert types</option>
            {EMAIL_TYPES.map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          From (UTC)
          <input
            type="date"
            name="from"
            className={adminField}
            defaultValue={filters.from}
          />
        </label>
        <label className="grid gap-1 text-sm">
          Through (UTC)
          <input
            type="date"
            name="to"
            className={adminField}
            defaultValue={filters.to}
          />
        </label>
      </AdminFilter>
      <div className={`${adminCard} overflow-x-auto p-0`}>
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-100 text-xs text-zinc-600">
            <tr>
              {[
                "Email",
                "Status",
                "Attempts",
                "Recorded (UTC)",
                "Provider ID / last error",
              ].map((label) => (
                <th key={label} scope="col" className="px-4 py-3">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {messages.map((email) => (
              <tr key={email.id}>
                <td className="max-w-sm px-4 py-4">
                  <Link className={adminLink} to={`/admin/emails/${email.id}`}>
                    {email.subject || "(No subject)"}
                  </Link>
                  <p className="mt-1 text-xs text-zinc-500">
                    {email.recipient} · {email.type}
                  </p>
                </td>
                <td className="px-4 py-4">{email.status}</td>
                <td className="px-4 py-4 tabular-nums">{email.attempts}</td>
                <td className="whitespace-nowrap px-4 py-4 text-xs text-zinc-600">
                  {adminDate(email.createdAt)}
                </td>
                <td className="max-w-xs break-words px-4 py-4 text-xs text-zinc-500">
                  {email.providerId || "—"}
                  {email.error && (
                    <p className="mt-1 text-red-700">{email.error}</p>
                  )}
                </td>
              </tr>
            ))}
            {!messages.length && (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-12 text-center text-zinc-500"
                >
                  {available
                    ? "No recorded application emails match these filters."
                    : "Email records will appear after the ledger is installed and a sender integration records them."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {available && (
        <>
          <p className="mt-3 text-xs text-zinc-500">
            {total} matching records. An empty ledger does not establish that no
            email was sent elsewhere.
          </p>
          <AdminPagination
            page={filters.page}
            hasMore={hasMore}
            label="Email pages"
          />
        </>
      )}
    </AdminAudienceLayout>
  );
}
