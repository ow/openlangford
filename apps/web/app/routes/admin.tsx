import { Link } from "react-router";
import { requireAdmin } from "../lib/auth.server";
import { PageHeader } from "../components/ui/page-header";

export const meta = () => [
  { title: "Admin area | Open Langford" },
  { name: "robots", content: "noindex, nofollow" },
];

export async function loader({ request }: { request: Request }) {
  await requireAdmin(request);
  return null;
}

export async function action({ request }: { request: Request }) {
  await requireAdmin(request);
  throw new Response("This page is read-only.", { status: 405, headers: { Allow: "GET" } });
}

export default function Admin() {
  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-3xl px-4 py-12">
        <PageHeader title="Admin area" description="Review council records and manage processing." />
        <ul className="grid gap-4 sm:grid-cols-2">
          {[
            ["/admin/matters", "Matter merge review", "Review proposed matches between matters."],
            ["/admin/pipeline", "Pipeline operations", "Inspect processing status and queued jobs."],
            ["/admin/profiles", "Profile review", "Review generated councillor profile drafts."],
            ["/admin/people", "People and memberships", "Manage council and staff records."],
            ["/speaker-alias", "Speaker aliases", "Review and correct speaker identities."],
          ].map(([to, title, description]) => (
            <li key={to}>
              <Link to={to} className="block h-full rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm transition-colors hover:border-brand-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                <h2 className="font-semibold text-zinc-900">{title}</h2>
                <p className="mt-1 text-sm text-zinc-600">{description}</p>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
