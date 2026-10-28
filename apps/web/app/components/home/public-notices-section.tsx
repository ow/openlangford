import { Megaphone, ExternalLink } from "lucide-react";
import { SectionHeading } from "../ui/section-heading";

interface PublicNoticesSectionProps {
  notices: Array<{ title: string; link: string; date: string }>;
  websiteUrl?: string;
}

export function PublicNoticesSection({
  notices,
  websiteUrl,
}: PublicNoticesSectionProps) {
  if (!notices || notices.length === 0) return null;

  return (
    <section>
      <SectionHeading
        title="Public notices"
        icon={Megaphone}
        action={
          websiteUrl && (
            <a
              href={`${websiteUrl}/EN/main/town/public.html`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-semibold text-brand-700 hover:text-brand-800"
            >
              View all
            </a>
          )
        }
      />

      <ul className="bg-surface rounded-2xl border border-zinc-200 shadow-sm overflow-hidden divide-y divide-zinc-100">
        {notices.map((notice, i) => (
          <li key={i}>
            <a
              href={notice.link}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-start gap-3 px-4 py-3.5 hover:bg-zinc-50 transition-colors group"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold leading-snug text-zinc-900 group-hover:text-brand-700 transition-colors line-clamp-2">
                  {notice.title}
                </p>
                <p className="text-xs text-zinc-500 mt-1">
                  {new Date(notice.date).toLocaleDateString("en-CA", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </p>
              </div>
              <ExternalLink className="mt-0.5 h-4 w-4 text-zinc-300 group-hover:text-brand-600 transition-colors shrink-0" />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
