import type { Route } from "./+types/admin-email";
import { Link } from "react-router";
import {
  adminRead,
  adminReadOnlyAction,
  boundedPage,
  privateAdminHeaders,
  requireUuid,
} from "../lib/admin-read.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { getEmailDetail } from "../services/email-admin.server";
import {
  AdminAudienceLayout,
  AdminPagination,
  LedgerCoverage,
  adminCard,
  adminDate,
  adminLink,
} from "../components/admin/audience-layout";

export const meta = () => [
  { title: "Email details | Admin | Open Langford" },
  { name: "robots", content: "noindex, nofollow" },
];
export const headers = privateAdminHeaders;
export const action = adminReadOnlyAction;
export async function loader({ request, params }: Route.LoaderArgs) {
  return adminRead(request, async () => {
    const id = requireUuid(params.id),
      page = boundedPage(new URL(request.url).searchParams.get("page"));
    return {
      ...(await getEmailDetail(getSupabaseAdminClient(), id, page)),
      page,
    };
  });
}
export default function AdminEmail({ loaderData }: Route.ComponentProps) {
  const { available, message, events, hasMore, page } = loaderData;
  return (
    <AdminAudienceLayout
      title="Email details"
      description="One application email and its recorded attempt / delivery timeline."
    >
      <Link
        className={`${adminLink} mb-5 inline-block text-sm`}
        to="/admin/emails"
      >
        ← Email activity
      </Link>
      <LedgerCoverage available={available} />
      {message && (
        <>
          <section className={`${adminCard} mb-5`}>
            <h2 className="text-xl font-bold">
              {message.subject || "(No subject)"}
            </h2>
            <p className="mt-1 text-sm text-zinc-500">
              {message.recipient} · {message.type}
            </p>
            {message.userId && (
              <Link
                className={`${adminLink} mt-3 inline-block text-sm`}
                to={`/admin/users/${message.userId}`}
              >
                View account
              </Link>
            )}
            <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {[
                ["Status", message.status],
                ["Attempts", message.attempts],
                ["Provider message ID", message.providerId || "Not recorded"],
                ["Created", adminDate(message.createdAt)],
                ["Updated", adminDate(message.updatedAt)],
                ["Accepted", adminDate(message.acceptedAt)],
                ["Delivered", adminDate(message.deliveredAt)],
                ["Failed", adminDate(message.failedAt)],
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <dt className="text-xs text-zinc-500">{label}</dt>
                  <dd className="mt-1 break-words">{value}</dd>
                </div>
              ))}
            </dl>
            {message.error && (
              <p className="mt-4 break-words text-sm text-red-700">
                {message.error}
              </p>
            )}
          </section>
          <section className={`${adminCard} mb-5`}>
            <h2 className="font-bold">Safe plain-text preview</h2>
            <p className="mt-1 text-xs text-zinc-500">
              Dedicated excerpts only. HTML, links and authentication-like
              content are withheld.
            </p>
            <pre className="mt-4 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
              {message.preview || "No safe plain-text preview available."}
            </pre>
          </section>
          <section className={adminCard}>
            <h2 className="font-bold">Attempts and provider events</h2>
            <ol className="mt-4 divide-y divide-zinc-100">
              {events.map((event) => (
                <li key={event.id} className="py-3 text-sm">
                  <p className="font-medium">
                    {event.type}
                    {event.attempt ? ` · Attempt ${event.attempt}` : ""}
                  </p>
                  <p className="mt-1 text-xs text-zinc-500">
                    {adminDate(event.occurredAt)}
                    {event.providerId ? ` · ${event.providerId}` : ""}
                  </p>
                  {event.error && (
                    <p className="mt-1 break-words text-red-700">
                      {event.error}
                    </p>
                  )}
                </li>
              ))}
            </ol>
            {!events.length && (
              <p className="py-5 text-sm text-zinc-500">
                No events recorded on this page.
              </p>
            )}
            <AdminPagination
              page={page}
              hasMore={hasMore}
              label="Event pages"
            />
          </section>
        </>
      )}
    </AdminAudienceLayout>
  );
}
