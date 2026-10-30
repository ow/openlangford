import { pageMeta } from "../lib/page-meta";
import type { Route } from "./+types/contact";
import { Form, useActionData, useNavigation } from "react-router";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { PageHeader } from "../components/ui/page-header";
import { getConfiguredAdminEmails } from "../lib/auth.server";
import { notifyContactMessage } from "../services/contact-messages.server";

export const meta = () => pageMeta("Contact", "Contact Open Langford with questions, feedback or corrections about Langford council records.", "/contact");

const RATE_LIMIT_WINDOW_MS = 10 * 60_000;
const RATE_LIMIT_MAX = 5;
const ipRequestLog = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (ipRequestLog.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  ipRequestLog.set(ip, recent);
  return recent.length > RATE_LIMIT_MAX;
}

export async function action({ request, context }: Route.ActionArgs) {
  const form = await request.formData();

  // Honeypot: real visitors never see or fill this field. Pretend success for bots.
  if (String(form.get("website") || "").trim()) return { ok: true as const };

  const name = String(form.get("name") || "").trim().slice(0, 200);
  const email = String(form.get("email") || "").trim().slice(0, 320);
  const message = String(form.get("message") || "").trim().slice(0, 5000);

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false as const, error: "Please enter a valid email so I can reply." };
  }
  if (message.length < 5) {
    return { ok: false as const, error: "Please write a message." };
  }

  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  if (isRateLimited(ip)) {
    return { ok: false as const, error: "Too many messages. Please try again later." };
  }

  const supabase = getSupabaseAdminClient();
  const { data: saved, error } = await supabase
    .from("contact_messages")
    .insert({ name: name || null, email, message, client_ip: ip })
    .select("id, created_at")
    .single();
  if (error || !saved) {
    console.error("Failed to save contact message:", error?.message);
    return { ok: false as const, error: "Something went wrong. Please try again." };
  }

  // Email the admins in the background; the submission has already succeeded.
  // RESEND_API_KEY is a runtime Worker secret (never inlined at build time); without it this no-ops.
  const cloudflare = (context as { cloudflare?: { env?: Partial<Env>; ctx?: ExecutionContext } } | undefined)?.cloudflare;
  const notification = notifyContactMessage({
    apiKey: cloudflare?.env?.RESEND_API_KEY,
    recipients: getConfiguredAdminEmails(),
    message: { id: saved.id, created_at: saved.created_at, name: name || null, email, message },
    supabase,
  }).catch(() => {
    console.error("[Contact] Notification email failed");
  });
  if (cloudflare?.ctx) cloudflare.ctx.waitUntil(notification);
  else await notification;
  return { ok: true as const };
}

const inputClass =
  "w-full rounded-lg border border-zinc-300 bg-surface px-3 py-2 text-zinc-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600";

export default function Contact() {
  const result = useActionData<typeof action>();
  const submitting = useNavigation().state === "submitting";

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-xl px-4 pt-6 pb-12 md:pt-10">
        <PageHeader title="Contact" />
        <div className="rounded-2xl border border-zinc-200 bg-surface p-6 shadow-sm sm:p-8">
          {result?.ok ? (
            <p className="text-zinc-700">Thanks, your message was sent. I'll reply by email.</p>
          ) : (
            <Form method="post" className="space-y-4">
              <p className="text-sm text-zinc-500">
                Questions, corrections or ideas. If something looks wrong, please include the page
                link.
              </p>
              <div>
                <label htmlFor="name" className="mb-1 block text-sm font-medium text-zinc-700">
                  Name <span className="font-normal text-zinc-400">(optional)</span>
                </label>
                <input id="name" name="name" type="text" autoComplete="name" className={inputClass} />
              </div>
              <div>
                <label htmlFor="email" className="mb-1 block text-sm font-medium text-zinc-700">
                  Email
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="message" className="mb-1 block text-sm font-medium text-zinc-700">
                  Message
                </label>
                <textarea
                  id="message"
                  name="message"
                  required
                  rows={6}
                  maxLength={5000}
                  className={inputClass}
                />
              </div>
              <div aria-hidden="true" className="absolute -left-[9999px]">
                <label htmlFor="website">Website</label>
                <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
              </div>
              {result && !result.ok && (
                <p role="alert" className="text-sm text-red-600">
                  {result.error}
                </p>
              )}
              <button
                type="submit"
                disabled={submitting}
                className="rounded-full bg-zinc-900 px-6 py-2.5 font-bold text-white transition hover:bg-zinc-800 disabled:opacity-50"
              >
                {submitting ? "Sending…" : "Send message"}
              </button>
            </Form>
          )}
        </div>
      </div>
    </div>
  );
}
