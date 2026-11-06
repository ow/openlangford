import { Link } from "react-router";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Route } from "./+types/notice";
import { pageMeta } from "../lib/page-meta";
import { noticeBySlug } from "../lib/notices";
import { ArrowDown, ArrowRight } from "lucide-react";
import { formatDate } from "../lib/utils";

export function loader({ params }: Route.LoaderArgs) {
  const notice = noticeBySlug(params.slug);
  if (!notice) throw new Response("Notice Not Found", { status: 404 });
  return { notice };
}

export const meta = ({ data }: Route.MetaArgs) =>
  data ? pageMeta(data.notice.title, data.notice.summary, `/notices/${data.notice.slug}`, "article") : [];

/** One notice: its date, title and body (Markdown from app/content/notices). */
export default function Notice({ loaderData }: Route.ComponentProps) {
  const { notice } = loaderData;
  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-3xl px-4 pt-6 pb-12 md:pt-10">
        <Link to="/notices" className="text-sm font-medium text-zinc-500 hover:text-brand-700">Notices</Link>
        <p className="mt-4 text-sm tabular-nums text-zinc-500">{formatDate(notice.date, { year: "numeric", month: "long", day: "numeric" })}</p>
        <h1 className="mt-1 text-3xl font-extrabold tracking-tight text-zinc-900 md:text-4xl">{notice.title}</h1>
        {notice.changes.length > 0 && (
          // Each change at a glance, before the details.
          <div className="mt-6 space-y-5">
            {notice.changes.map((c) => (
              <div key={c.was}>
                {c.meeting && (
                  <p className="mb-1.5 text-sm font-semibold text-zinc-700">
                    {c.href ? <Link to={c.href} className="hover:text-brand-700 hover:underline">{c.meeting} →</Link> : c.meeting}
                  </p>
                )}
                <div className="grid items-center gap-3 sm:grid-cols-[1fr_auto_1fr]">
                  <div className="rounded-2xl border border-zinc-200 bg-surface px-5 py-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Was</p>
                    <p className="mt-1 text-lg font-semibold text-zinc-500 line-through decoration-zinc-300">{c.was}</p>
                  </div>
                  <ArrowRight className="mx-auto hidden h-6 w-6 text-zinc-400 sm:block" aria-hidden="true" />
                  <ArrowDown className="mx-auto h-5 w-5 text-zinc-400 sm:hidden" aria-hidden="true" />
                  <div className="rounded-2xl border border-brand-200 bg-brand-50 px-5 py-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">Now</p>
                    <p className="mt-1 text-lg font-semibold text-zinc-900">{c.now}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        <article className="prose prose-zinc mt-6 max-w-none rounded-2xl border border-zinc-200 bg-surface p-6 shadow-sm sm:p-8 prose-h2:mb-3 prose-h2:mt-8 prose-h2:text-lg prose-h2:font-semibold prose-a:text-brand-700 prose-blockquote:font-normal prose-blockquote:not-italic prose-blockquote:text-zinc-600">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{notice.body}</ReactMarkdown>
        </article>
      </div>
    </div>
  );
}
