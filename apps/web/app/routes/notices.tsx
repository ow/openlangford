import { Link } from "react-router";
import { pageMeta } from "../lib/page-meta";
import { NOTICES } from "../lib/notices";
import { formatDate } from "../lib/utils";
import { PageHeader } from "../components/ui/page-header";

export const meta = () => pageMeta("Notices", "Changes to how Langford council works and chances to have your say, from Open Langford.", "/notices");

/** Every notice, newest first. */
export default function Notices() {
  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-3xl px-4 pt-6 pb-12 md:pt-10">
        <PageHeader title="Notices" description="Changes to how Council works, and chances to have your say." />
        <ul className="divide-y divide-zinc-100 rounded-2xl border border-zinc-200 bg-surface shadow-sm">
          {NOTICES.map((n) => (
            <li key={n.slug} className="px-5 py-4">
              <p className="text-xs tabular-nums text-zinc-500">{formatDate(n.date, { year: "numeric", month: "long", day: "numeric" })}</p>
              <Link to={`/notices/${n.slug}`} className="mt-0.5 block font-semibold text-zinc-900 hover:text-brand-700">{n.title}</Link>
              {n.summary && <p className="mt-1 text-sm text-zinc-600">{n.summary}</p>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
