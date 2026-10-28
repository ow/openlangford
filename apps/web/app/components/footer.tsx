import { Link, useRouteLoaderData } from "react-router";
import type { Municipality } from "../lib/types";
import { siteName } from "../lib/site-name";
import { useSiteFlags } from "../lib/use-site-flags";

export function Footer() {
  const rootData = useRouteLoaderData("root") as { municipality?: Municipality; user?: unknown } | undefined;
  const name = siteName(rootData?.municipality);
  const { signupsEnabled } = useSiteFlags();
  const signedOut = !rootData?.user;

  return (
    <footer className="mt-auto border-t border-zinc-200 bg-surface py-8 text-sm text-zinc-500">
      <div className="container mx-auto flex max-w-7xl flex-col gap-4 px-4 sm:flex-row sm:items-center sm:justify-between">
        <p>
          © {new Date().getFullYear()} {name}. Forked from{" "}
          <a
            href="https://github.com/kpeatt/viewroyal"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-zinc-700 underline-offset-4 hover:text-brand-700 hover:underline"
          >
            ViewRoyal.ai
          </a>
        </p>
        <nav className="flex flex-wrap items-center gap-x-5 gap-y-2" aria-label="Footer">
          <Link to="/about" className="hover:text-zinc-900">About</Link>
          <Link to="/contact" className="hover:text-zinc-900">Contact</Link>
          <Link to="/privacy" className="hover:text-zinc-900">Privacy</Link>
          <Link to="/terms" className="hover:text-zinc-900">Terms</Link>
          {signedOut && (
            <>
              <span aria-hidden="true" className="hidden h-4 w-px bg-zinc-200 sm:block" />
              <Link to="/login" className="hover:text-zinc-900">Log in</Link>
              {signupsEnabled && (
                <Link to="/signup" className="font-medium text-brand-700 hover:text-brand-800">Sign up</Link>
              )}
            </>
          )}
        </nav>
      </div>
    </footer>
  );
}
