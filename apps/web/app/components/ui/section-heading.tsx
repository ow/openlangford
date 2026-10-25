import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { cn } from "~/lib/utils";

interface SectionHeadingProps {
  title: ReactNode;
  icon?: LucideIcon;
  description?: ReactNode;
  /** Optional "View all" style link. */
  href?: string;
  linkLabel?: string;
  /** Arbitrary right-side content; overrides href. */
  action?: ReactNode;
  className?: string;
}

export function SectionHeading({
  title,
  icon: Icon,
  description,
  href,
  linkLabel = "View all",
  action,
  className,
}: SectionHeadingProps) {
  return (
    <div className={cn("mb-4 flex items-center justify-between gap-4", className)}>
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-lg font-bold tracking-tight text-zinc-900">
          {Icon && <Icon className="h-5 w-5 text-brand-600" aria-hidden="true" />}
          {title}
        </h2>
        {description && (
          <p className="mt-0.5 text-sm text-zinc-500">{description}</p>
        )}
      </div>
      {action ??
        (href && (
          <Link
            to={href}
            className="group inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-brand-700 hover:text-brand-800"
          >
            {linkLabel}
          </Link>
        ))}
    </div>
  );
}
