import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "~/lib/utils";
import { ReportIssueButton } from "../report-issue";

interface DetailHeaderProps {
  /** Parent page; the breadcrumb trail is Home / parent. */
  back?: { to: string; label: string };
  /** Short facts shown on a quiet line under the title (date, length, term…). */
  meta?: ReactNode[];
  title: ReactNode;
  /** Inline next to the title (status badges). */
  badges?: ReactNode;
  /** Before the facts, on their line (a status badge that belongs with them). */
  metaLead?: ReactNode;
  /** On the breadcrumb row, at the right (a compact follow button). */
  metaAction?: ReactNode;
  /** False when the page puts its own Report issue button elsewhere (topic pages, beside their status). */
  reportButton?: boolean;
  /** Right-aligned on desktop, below the title on mobile (source links, follow…). */
  actions?: ReactNode;
  /** A small line under the facts (where the schedule came from). */
  note?: ReactNode;
  /** Optional lead paragraph under the title. */
  description?: ReactNode;
  className?: string;
}

/**
 * Header for detail pages: a breadcrumb trail (Home / parent) above the title,
 * then the page's facts on their own quiet line under it.
 */
export function DetailHeader({
  back,
  meta = [],
  title,
  badges,
  metaLead,
  metaAction,
  reportButton = true,
  actions,
  description,
  note,
  className,
}: DetailHeaderProps) {
  const items = meta.filter(Boolean);
  return (
    <header className={cn("mb-8", className)}>
      {/* The breadcrumb row spans the whole header, so a follow button sits at its right edge on every screen. */}
      {(back || metaAction) && (
        <div className="mb-2 flex items-center justify-between gap-3">
        {back ? (
        <nav aria-label="Breadcrumb" className="text-sm">
          <ol className="flex flex-wrap items-center gap-x-1.5 text-zinc-500">
            <li>
              <Link to="/" className="hover:text-brand-700">Home</Link>
            </li>
            <li aria-hidden="true" className="text-zinc-300">/</li>
            <li>
              <Link to={back.to} className="font-medium text-zinc-700 hover:text-brand-700">
                {back.label}
              </Link>
            </li>
          </ol>
        </nav>
        ) : <span />}
        <div className="flex shrink-0 items-center gap-1.5">
          {reportButton && <ReportIssueButton />}
          {metaAction}
        </div>
        </div>
      )}
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="text-3xl font-extrabold tracking-tight text-zinc-900 md:text-4xl">
              {title}
            </h1>
            {badges}
          </div>
          {metaLead ? (
            // The status first, then the facts, wrapping as one sentence.
            <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm text-zinc-500">
              {metaLead}
              <span>
                {items.map((item, i) => (
                  <span key={i}>
                    {i > 0 && <span aria-hidden="true" className="px-1.5 text-zinc-300">·</span>}
                    {item}
                  </span>
                ))}
              </span>
            </p>
          ) : items.length > 0 && (
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-zinc-500">
              {items.map((item, i) => (
                <span key={i} className="inline-flex items-center gap-2">
                  {i > 0 && (
                    <span aria-hidden="true" className="text-zinc-300">
                      ·
                    </span>
                  )}
                  {item}
                </span>
              ))}
            </p>
          )}
          {note}
          {description && (
            <p className="mt-3 max-w-3xl text-base leading-relaxed text-zinc-600">
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
    </header>
  );
}
