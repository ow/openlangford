import type { ReactNode } from "react";
import { useRouteLoaderData } from "react-router";
import { cn } from "~/lib/utils";

/** Root loader flag (per request, never in the public data cache). */
export function useIsAdmin(): boolean {
  return !!(useRouteLoaderData("root") as { isAdmin?: boolean } | undefined)?.isAdmin;
}

/**
 * The one treatment for admin-only controls on public pages: a dashed amber frame with an
 * "Admin" tag, so an admin can always tell what the public doesn't see. Renders nothing for
 * everyone else; the action behind the control must still check requireAdmin on the server.
 */
export function AdminOnly({ children, className }: { children: ReactNode; className?: string }) {
  if (!useIsAdmin()) return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-dashed border-amber-400 bg-amber-50 px-1.5 py-0.5",
        className,
      )}
    >
      <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700">Admin</span>
      {children}
    </span>
  );
}
