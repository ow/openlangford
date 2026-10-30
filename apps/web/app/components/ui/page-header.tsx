import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/** Standard width for index/list pages. Detail pages may go narrower. */
export const PAGE_CONTAINER = "container mx-auto max-w-6xl px-4";

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  /** Right-aligned controls (view switchers, primary actions). */
  actions?: ReactNode;
  /** Secondary row under the description (sub-nav links, meta). */
  children?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  icon: Icon,
  actions,
  children,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn("flex flex-col gap-4 pb-4 md:pb-8", className)}>
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          {Icon && (
            <div className="hidden shrink-0 rounded-xl bg-brand-50 p-2.5 text-brand-700 ring-1 ring-brand-100 sm:block">
              <Icon className="h-6 w-6" aria-hidden="true" />
            </div>
          )}
          <div className="min-w-0">
            <h1 className="text-3xl font-extrabold tracking-tight text-zinc-900 md:text-4xl">
              {title}
            </h1>
            {description && (
              <p className="mt-2 max-w-2xl text-base text-zinc-600">
                {description}
              </p>
            )}
          </div>
        </div>
        {actions && (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        )}
      </div>
      {children}
    </header>
  );
}
