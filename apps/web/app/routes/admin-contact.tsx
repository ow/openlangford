import { Form, Link, data, useNavigation } from "react-router";
import type { Route } from "./+types/admin-contact";
import { requireAdmin } from "../lib/auth.server";
import { adminRead, privateAdminHeaders, requireUuid } from "../lib/admin-read.server";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { adminCard, adminLink } from "../components/admin/audience-layout";
import { PageHeader } from "../components/ui/page-header";
import { cn } from "../lib/utils";
import {
  CONTACT_FILTERS,
  civicTime,
  contactFilter,
  listContactMessages,
  replyMailto,
  setContactMessageHandled,
} from "../services/contact-messages.server";

export const meta = () => [
  { title: "Contact messages | Admin | Open Langford" },
  { name: "robots", content: "noindex, nofollow" },
];
export const headers = privateAdminHeaders;

export async function loader({ request }: Route.LoaderArgs) {
  return adminRead(request, async () => {
    const filter = contactFilter(new URL(request.url).searchParams.get("show"));
    return { filter, ...(await listContactMessages(getSupabaseAdminClient(), filter)) };
  });
}

export async function action({ request }: Route.ActionArgs) {
  try {
    const user = await requireAdmin(request);
    const form = await request.formData();
    const intent = String(form.get("intent") || "");
    if (intent !== "handle" && intent !== "reopen") {
      return data({ error: "Unknown action." }, { status: 400, headers: privateAdminHeaders() });
    }
    const id = requireUuid(String(form.get("id") || ""));
    await setContactMessageHandled(getSupabaseAdminClient(), id, intent === "handle", user.id);
    return data({ ok: true as const }, { headers: privateAdminHeaders() });
  } catch (error) {
    if (error instanceof Response) {
      const headers = new Headers(error.headers);
      privateAdminHeaders().forEach((value, key) => headers.set(key, value));
      throw new Response(error.body, { status: error.status, statusText: error.statusText, headers });
    }
    return data({ error: "Could not update the message. Please try again." }, { status: 503, headers: privateAdminHeaders() });
  }
}

const LABELS = { open: "Open", handled: "Handled", all: "All" } as const;

export default function AdminContact({ loaderData, actionData }: Route.ComponentProps) {
  const { filter, messages, openCount } = loaderData;
  const navigation = useNavigation();
  const pendingId = navigation.state !== "idle" ? navigation.formData?.get("id") : null;
  return (
    <main className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-4xl px-4 py-10">
        <Link to="/admin" className={`${adminLink} mb-5 inline-block text-sm`}>
          ← Admin area
        </Link>
        <PageHeader title="Contact messages" description="Messages sent through the public contact form, newest first. Times are Pacific." />
        <nav aria-label="Filter messages" className="mb-5 flex gap-2 text-sm">
          {CONTACT_FILTERS.map((value) => (
            <Link
              key={value}
              to={value === "open" ? "?" : `?show=${value}`}
              aria-current={filter === value ? "page" : undefined}
              className={cn(
                "rounded-full border px-3 py-1 font-medium",
                filter === value ? "border-brand-700 bg-brand-700 text-white" : "border-zinc-300 bg-surface text-zinc-700 hover:border-brand-300",
              )}
            >
              {LABELS[value]}
              {value === "open" && <span className="ml-1.5 tabular-nums">({openCount})</span>}
            </Link>
          ))}
        </nav>
        {actionData && "error" in actionData && (
          <p role="alert" className="mb-4 text-sm text-red-700">
            {actionData.error}
          </p>
        )}
        {messages.length === 0 ? (
          <p className={cn(adminCard, "text-sm text-zinc-600")}>
            {filter === "open" ? "No open messages." : "No messages."}
          </p>
        ) : (
          <ul className="space-y-4">
            {messages.map((m) => (
              <li key={m.id} className={cn(adminCard, m.handled_at && "opacity-75")}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-zinc-900">{m.name || "No name given"}</p>
                    <a className={cn(adminLink, "break-all text-sm")} href={replyMailto(m.email)}>
                      {m.email}
                    </a>
                    <p className="mt-1 text-xs text-zinc-500">
                      <time dateTime={m.created_at}>{civicTime(m.created_at)}</time>
                      {m.handled_at ? ` · Handled ${civicTime(m.handled_at)}` : " · Open"}
                      {!m.notified_at && <span className="ml-1 font-medium text-amber-700">· Email not sent</span>}
                    </p>
                  </div>
                  <Form method="post">
                    <input type="hidden" name="id" value={m.id} />
                    <button
                      name="intent"
                      value={m.handled_at ? "reopen" : "handle"}
                      disabled={pendingId === m.id}
                      className="h-9 rounded-lg border border-zinc-300 bg-surface px-3 text-sm font-semibold text-zinc-800 hover:border-brand-300 disabled:opacity-50"
                    >
                      {m.handled_at ? "Reopen" : "Mark handled"}
                    </button>
                  </Form>
                </div>
                <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-800">{m.message}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
