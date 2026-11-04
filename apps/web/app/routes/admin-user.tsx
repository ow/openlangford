import { accountEmailFor } from "../lib/redact-email";
import type { Route } from "./+types/admin-user";
import { Link, data } from "react-router";
import {
  adminRead,
  boundedPage,
  privateAdminHeaders,
  requireUuid,
} from "../lib/admin-read.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { getAudienceUser } from "../services/audience-admin.server";
import { getUserStaff, sendRoleGrantEmail, setUserRole } from "../services/staff.server";
import { isAdminEmail, requireAdmin } from "../lib/auth.server";
import { StaffAccessSection } from "../components/admin/staff-access-section";
import {
  AdminAudienceLayout,
  AdminPagination,
  adminCard,
  adminDate,
  adminLink,
} from "../components/admin/audience-layout";

export const meta = () => [
  { title: "User details | Admin | Open Langford" },
  { name: "robots", content: "noindex, nofollow" },
];
export const headers = privateAdminHeaders;
/** Admins grant or remove a staff role (recorded in staff_actions by requireAdmin). */
export async function action({ request, params, context }: Route.ActionArgs) {
  try {
    const admin = await requireAdmin(request);
    const id = requireUuid(params.id);
    const form = await request.formData();
    const role = String(form.get("role") || "");
    if (form.get("intent") !== "role" || !["admin", "moderator", "none"].includes(role) || id === admin.id) {
      return data({ error: "Unknown change." }, { status: 400, headers: privateAdminHeaders() });
    }
    const supabase = getSupabaseAdminClient();
    const before = (await getUserStaff(supabase, id)).grantedRole;
    const granted = role === "none" ? null : (role as "admin" | "moderator");
    await setUserRole(supabase, id, granted, admin.id);
    // A new moderator or admin gets a welcome email at their confirmed account address.
    if (granted && granted !== before) {
      const { data: account } = await supabase.auth.admin.getUserById(id);
      const cloudflare = (context as { cloudflare?: { env?: Partial<Env>; ctx?: ExecutionContext } } | undefined)?.cloudflare;
      const sending = sendRoleGrantEmail({
        apiKey: cloudflare?.env?.RESEND_API_KEY,
        to: account.user?.email_confirmed_at ? account.user.email : null,
        role: granted,
        userId: id,
        supabase,
      });
      if (cloudflare?.ctx) cloudflare.ctx.waitUntil(sending);
      else await sending;
    }
    return data({ ok: true }, { headers: privateAdminHeaders() });
  } catch (error) {
    if (error instanceof Response) {
      const headers = new Headers(error.headers);
      privateAdminHeaders().forEach((value, key) => headers.set(key, value));
      throw new Response(error.body, { status: error.status, statusText: error.statusText, headers });
    }
    return data({ error: "Could not change the role. Please try again." }, { status: 503, headers: privateAdminHeaders() });
  }
}
export async function loader({ request, params }: Route.LoaderArgs) {
  return adminRead(request, async (viewerRole, viewer) => {
    const id = requireUuid(params.id),
      page = boundedPage(new URL(request.url).searchParams.get("page"));
    const supabase = getSupabaseAdminClient();
    const audience = await getAudienceUser(supabase, id, page);  // 404s an unknown account first
    const staff = await getUserStaff(supabase, id);
    const email = accountEmailFor(viewerRole);
    return {
      ...audience,
      user: { ...audience.user, email: email(audience.user.email) },
      preferences: audience.preferences && { ...audience.preferences, notificationEmail: email(audience.preferences.notificationEmail) },
      page,
      staff: { ...staff, ownerByEmail: isAdminEmail(audience.user.email) && !!audience.user.confirmedAt },
      canGrant: viewerRole === "admin",
      isSelf: viewer.id === id,
    };
  });
}
export default function AdminUser({ loaderData }: Route.ComponentProps) {
  const { user, preferences, subscriptions, subscriptionCount, page, hasMore, staff, canGrant, isSelf } =
    loaderData;
  const details = [
    ["Account email", user.email || "No email"],
    [
      "Email confirmation",
      user.confirmedAt ? `Confirmed ${adminDate(user.confirmedAt)}` : "Pending",
    ],
    ["Joined", adminDate(user.createdAt)],
    [
      "Last sign-in",
      user.lastSignInAt ? adminDate(user.lastSignInAt) : "Never signed in",
    ],
    [
      "Onboarding",
      !user.hasProfile
        ? "No profile yet"
        : user.onboardingCompleted
          ? "Complete"
          : "Incomplete",
    ],
    [
      "Notification address",
      preferences?.notificationEmail || "Account email (default)",
    ],
    ["Neighbourhood", preferences?.neighborhood || "Not set"],
    [
      "Digest preference",
      preferences
        ? preferences.digestEnabled
          ? "Opted in"
          : "Off"
        : "Not set",
    ],
    [
      "Digest frequency",
      preferences?.digestFrequency === "weekly"
        ? "Weekly (saved preference; scheduling not verified)"
        : preferences
          ? "Each meeting"
          : "Not set",
    ],
  ];
  return (
    <AdminAudienceLayout
      title={user.name || user.email || "Account"}
      description={user.name ? user.email : undefined}
      back={{ to: "/admin/users", label: "Accounts" }}
    >
      {!user.hasProfile && (
        <p className="mb-5 rounded-xl border border-zinc-200 bg-surface p-4 text-sm">
          This Auth account has no saved profile yet. It is still included in
          the user directory.
        </p>
      )}
      <section className={`${adminCard} mb-6`} aria-label="Account preferences">
        <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {details.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs font-medium text-zinc-500">{label}</dt>
              <dd className="mt-1 break-words text-sm text-zinc-900">
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <Link to={`/admin/emails?user=${user.id}`} className={`${adminLink} mt-5 inline-block text-sm`}>
          Emails sent to this account →
        </Link>
        <p className="mt-3 text-xs text-zinc-500">
          Saved choices are not proof of delivery readiness. An account’s
          confirmed email does not verify a different notification address.
        </p>
      </section>
      <section className={adminCard}>
        <h2 className="text-lg font-bold">
          Active subscriptions{" "}
          <span className="font-normal text-zinc-500">
            ({subscriptionCount})
          </span>
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          Current saved subscriptions only. Removed subscriptions are not
          retained as history.
        </p>
        <ul className="mt-4 divide-y divide-zinc-100">
          {subscriptions.map((sub) => (
            <li
              key={sub.id}
              className="flex flex-wrap justify-between gap-2 py-3 text-sm"
            >
              <div>
                <p className="font-medium">{sub.label}</p>
                <p className="mt-1 text-xs text-zinc-500">
                  {sub.type}
                  {sub.radius ? ` · ${sub.radius} m radius` : ""}
                </p>
              </div>
              <time className="text-xs text-zinc-500">
                {adminDate(sub.createdAt)}
              </time>
            </li>
          ))}
        </ul>
        {!subscriptions.length && (
          <p className="py-6 text-sm text-zinc-500">
            No active subscriptions on this page.
          </p>
        )}
        <AdminPagination
          page={page}
          hasMore={hasMore}
          label="Subscription pages"
        />
      </section>
      <StaffAccessSection staff={staff} canGrant={canGrant} isSelf={isSelf} />
    </AdminAudienceLayout>
  );
}
