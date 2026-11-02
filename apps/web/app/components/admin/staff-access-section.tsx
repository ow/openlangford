import { Form, useNavigation } from "react-router";
import type { StaffAction } from "../../services/staff.server";
import { adminCard, adminDate } from "./audience-layout";

type Staff = {
  ownerByEmail: boolean;
  grantedRole: "admin" | "moderator" | null;
  grantedAt: string | null;
  actions: StaffAction[];
};

const ROLE_HELP = {
  moderator: "Uses the review tools, accounts, email activity and contact messages.",
  admin: "Everything a moderator can, plus the pipeline, people and memberships, and granting roles.",
};

/** A user's staff role (admins can change it) and what they've done with staff tools. */
export function StaffAccessSection({ staff, canGrant, isSelf }: { staff: Staff; canGrant: boolean; isSelf: boolean }) {
  const pending = useNavigation().formData?.get("intent") === "role";
  const role = staff.ownerByEmail ? "admin" : staff.grantedRole;
  return (
    <section className={`${adminCard} mt-6`} aria-labelledby="staff-heading">
      <h2 id="staff-heading" className="text-lg font-bold">Staff access</h2>
      <p className="mt-1 text-sm text-zinc-600">
        {staff.ownerByEmail
          ? "Owner: an admin through the site's admin email list. Change that in the site settings, not here."
          : role
            ? `${role === "admin" ? "Admin" : "Moderator"} since ${adminDate(staff.grantedAt)}. ${ROLE_HELP[role]}`
            : "No staff role. A regular account."}
      </p>
      {canGrant && !staff.ownerByEmail && !isSelf && (
        <Form method="post" className="mt-4 flex flex-wrap items-center gap-2 text-sm">
          <input type="hidden" name="intent" value="role" />
          {(["moderator", "admin", "none"] as const).map((value) => {
            const current = (role ?? "none") === value;
            return (
              <button key={value} type="submit" name="role" value={value} disabled={current || pending}
                className={current
                  ? "rounded-lg border border-brand-300 bg-brand-50 px-3 py-1.5 font-medium text-brand-800"
                  : "rounded-lg border border-zinc-200 px-3 py-1.5 text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"}>
                {value === "none" ? "No role" : value === "admin" ? "Admin" : "Moderator"}
              </button>
            );
          })}
        </Form>
      )}
      <h3 className="mt-6 text-sm font-semibold text-zinc-900">Recent staff activity</h3>
      {staff.actions.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-500">Nothing recorded yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-zinc-100 text-sm">
          {staff.actions.map((a) => {
            const shown = Object.entries(a.detail).filter(([k]) => k !== "intent");
            return (
              <li key={a.id} className="py-2">
                <div className="flex flex-wrap justify-between gap-2">
                  <span className="font-medium text-zinc-900">
                    {a.path}{a.action ? <span className="font-normal text-zinc-500"> · {a.action}</span> : null}
                  </span>
                  <time className="text-xs text-zinc-500">{adminDate(a.created_at)}</time>
                </div>
                {shown.length > 0 && (
                  <p className="mt-0.5 truncate text-xs text-zinc-500">
                    {shown.map(([k, v]) => `${k}: ${v}`).join(" · ")}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
