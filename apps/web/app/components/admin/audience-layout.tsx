import { Form, Link, useLocation } from "react-router";
import type { ReactNode } from "react";
import { PageHeader } from "../ui/page-header";

export const adminCard =
  "rounded-2xl border border-zinc-200 bg-surface p-5 shadow-sm";
export const adminField =
  "h-10 rounded-lg border border-zinc-300 bg-surface px-3 text-sm";
export const adminLink =
  "font-semibold text-brand-700 underline-offset-4 hover:underline";
export function AdminAudienceLayout({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-6xl px-4 py-10">
        <Link to="/admin" className={`${adminLink} mb-5 inline-block text-sm`}>
          ← Admin area
        </Link>
        <PageHeader title={title} description={description}>
          <nav
            aria-label="Audience administration"
            className="flex gap-5 text-sm"
          >
            <Link className={adminLink} to="/admin/users">
              Users
            </Link>
            <Link className={adminLink} to="/admin/emails">
              Email activity
            </Link>
          </nav>
        </PageHeader>
        {children}
      </div>
    </main>
  );
}
export function AdminPagination({
  page,
  hasMore,
  label = "pages",
  parameter = "page",
}: {
  page: number;
  hasMore: boolean;
  label?: string;
  parameter?: string;
}) {
  const location = useLocation();
  function href(next: number) {
    const params = new URLSearchParams(location.search);
    params.set(parameter, String(next));
    return `${location.pathname}?${params}`;
  }
  return (
    <nav aria-label={label} className="mt-5 flex items-center gap-5 text-sm">
      {page > 1 && (
        <Link className={adminLink} to={href(page - 1)}>
          Previous
        </Link>
      )}
      <span className="text-zinc-500">Page {page}</span>
      {hasMore && (
        <Link className={adminLink} to={href(page + 1)}>
          Next
        </Link>
      )}
    </nav>
  );
}
export function AdminFilter({ children }: { children: ReactNode }) {
  return (
    <Form
      method="get"
      className={`${adminCard} mb-5 flex flex-wrap items-end gap-3`}
    >
      {children}
      <button className="h-10 rounded-lg bg-brand-700 px-4 text-sm font-semibold text-white">
        Apply filters
      </button>
    </Form>
  );
}
export function adminDate(value: string | null | undefined) {
  return value
    ? new Date(value).toLocaleString("en-CA", {
        timeZone: "UTC",
        dateStyle: "medium",
        timeStyle: "short",
      }) + " UTC"
    : "—";
}
export function LedgerCoverage({ available }: { available: boolean }) {
  return (
    <div
      role="status"
      className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-relaxed text-amber-950"
    >
      {!available && (
        <p className="font-semibold">
          Application email ledger is not installed.
        </p>
      )}
      <p>
        {available
          ? "Only application alerts recorded by the ledger integration appear here."
          : "The reviewed database migration must be applied before email records can be displayed."}{" "}
        This view does not enable sending or reconstruct past emails. Supabase
        Auth confirmation and password-reset emails are separate and are not
        included.
      </p>
      <p className="mt-1">
        Accepted means the provider accepted a send request. Delivered requires
        a verified provider delivery event.
      </p>
    </div>
  );
}
