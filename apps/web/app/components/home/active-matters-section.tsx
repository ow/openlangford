import { Link } from "react-router";
import { matterPath } from "../../lib/paths";
import { Gavel, ChevronRight } from "lucide-react";
import { formatDate } from "../../lib/utils";
import { SectionHeading } from "../ui/section-heading";
import { displayTitle, matterTitle } from "../../lib/display-text";

interface ActiveMattersSectionProps {
  matters: Array<{
    id: number;
    title: string;
    category?: string;
    first_seen?: string;
    last_seen?: string;
    summary?: string | null;
  }>;
}

export function ActiveMattersSection({ matters }: ActiveMattersSectionProps) {
  if (matters.length === 0) return null;

  return (
    <section>
      <SectionHeading title="Active matters" icon={Gavel} href="/matters" />

      <ul className="bg-surface rounded-2xl border border-zinc-200 shadow-sm overflow-hidden divide-y divide-zinc-100">
        {matters.map((matter) => {
          // A single recorded appearance may be years old; it does not mean new.
          const ageDays = matter.first_seen
            ? (Date.now() - Date.parse(`${matter.first_seen}T00:00:00Z`)) / 86_400_000
            : NaN;
          const isNew = ageDays >= 0 && ageDays <= 30;
          return (
            <li key={matter.id}>
              <Link
                to={matterPath(matter)}
                className="group flex items-start gap-3 px-4 py-3.5 hover:bg-zinc-50 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold leading-snug text-zinc-900 line-clamp-2 group-hover:text-brand-700">
                    {matterTitle(matter)}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-zinc-500">
                    <span className="font-medium text-zinc-600">
                      {matter.category || "General"}
                    </span>
                    {matter.last_seen && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{formatDate(matter.last_seen)}</span>
                      </>
                    )}
                    {isNew && (
                      <span className="ml-0.5 rounded-full bg-brand-50 px-1.5 py-px text-[10px] font-semibold text-brand-700">
                        New
                      </span>
                    )}
                  </p>
                </div>
                <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-zinc-300 group-hover:text-brand-600" />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
