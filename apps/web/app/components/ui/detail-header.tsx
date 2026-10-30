import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "~/lib/utils";

interface DetailHeaderProps {
  /** Parent page; the breadcrumb trail is Home / parent. */
  back?: { to: string; label: string };
  /** Short facts shown on a quiet line under the title (date, length, term…). */
  meta?: ReactNode[];
  title: ReactNode;
  /** Inline next to the title (status badges). */
  badges?: ReactNode;
  /** Right-aligned on desktop, below the title on mobile (source links, follow…). */
  actions?: ReactNode;
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
  actions,
  description,
  className,
}: DetailHeaderProps) {
  const items = meta.filter(Boolean);
  return (
    <header className={cn("mb-8", className)}>
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          {back && (
            <nav aria-label="Breadcrumb" className="mb-2 text-sm">
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
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="text-3xl font-extrabold tracking-tight text-zinc-900 md:text-4xl">
              {title}
            </h1>
            {badges}
          </div>
          {items.length > 0 && (
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
