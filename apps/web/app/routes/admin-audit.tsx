import type { Route } from "./+types/admin-audit";
import { Link } from "react-router";
import { adminRead, adminReadOnlyAction, privateAdminHeaders } from "../lib/admin-read.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { auditFilters, getAuditPage } from "../services/staff-audit.server";
import { staffActionLabel, staffActionPage } from "../lib/staff-actions";
import { AdminAudienceLayout, AdminFilter, AdminPagination, adminCard, adminField, adminLink } from "../components/admin/audience-layout";

export const meta = () => [
  { title: "Audit log | Admin | Open Langford" },
  { name: "robots", content: "noindex, nofollow" },
];
export const headers = privateAdminHeaders;
export const action = adminReadOnlyAction;

/** Every change admins and moderators made through the staff tools (staff_actions). Admins only. */
export async function loader({ request }: Route.LoaderArgs) {
  return adminRead(request, async () => {
    const filters = auditFilters(new URL(request.url));
    return { ...(await getAuditPage(getSupabaseAdminClient(), filters)), filters };
  }, "admin");
}

const when = (value: string) =>
  new Date(value).toLocaleString("en-CA", { timeZone: "America/Vancouver", dateStyle: "medium", timeStyle: "short" });

export default function AdminAudit({ loaderData }: Route.ComponentProps) {
  const { rows, total, hasMore, people, actions, filters } = loaderData;
  const nameOf = new Map(people.map((p) => [p.id, p.label]));
  return (
    <AdminAudienceLayout
      title="Audit log"
      description={`Every change admins and moderators made through the staff tools, newest first. ${total.toLocaleString()} ${total === 1 ? "action" : "actions"}${filters.person || filters.action || filters.q ? " match" : ""}. Viewing pages isn't recorded.`}
    >
      <AdminFilter>
        <label className="grid gap-1 text-sm">
          Person
          <select name="person" className={adminField} defaultValue={filters.person}>
            <option value="">Everyone</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Action
          <select name="action" className={adminField} defaultValue={filters.action}>
            <option value="">All actions</option>
            <option value="agent">Agent fixes</option>
            {actions.map((a) => <option key={a} value={a}>{staffActionLabel(a)}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Page
          <input name="q" maxLength={200} className={adminField} defaultValue={filters.q} placeholder="Address contains…" />
        </label>
      </AdminFilter>

      <div className={`${adminCard} overflow-x-auto p-0`}>
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-100 text-xs text-zinc-600">
            <tr>
              {["When (Pacific)", "Who", "What", "Page"].map((label) => (
                <th key={label} scope="col" className="px-4 py-3">{label}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {rows.map((row) => {
              const page = staffActionPage(row.path, row.detail);
              return (
                <tr key={row.id} className="align-top">
                  <td className="whitespace-nowrap px-4 py-3 tabular-nums text-zinc-600">{when(row.created_at)}</td>
                  <td className="px-4 py-3">
                    <Link className={adminLink} to={`/admin/users/${row.user_id}`}>{nameOf.get(row.user_id) ?? "Unknown account"}</Link>
                    <span className="ml-1.5 text-xs text-zinc-500">{row.role}</span>
                  </td>
                  <td className="px-4 py-3 text-zinc-800">{staffActionLabel(row.action, row.detail)}</td>
                  <td className="max-w-md px-4 py-3">
                    {page ? <Link className={`${adminLink} break-all`} to={page}>{page}</Link> : <span className="text-zinc-500">{row.path}</span>}
                  </td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-zinc-500">No actions match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <AdminPagination page={filters.page} hasMore={hasMore} label="Audit log pages" />
    </AdminAudienceLayout>
  );
}
