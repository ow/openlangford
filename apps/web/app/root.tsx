import { getSearchBudgetForDisplay } from "./services/search-budget.server";
import { SITE_NAME } from "./lib/site-name";
import { SITE_ORIGIN } from "./lib/og";
import { DEFAULT_MUNICIPALITY } from "./lib/site-config";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  redirect,
  Scripts,
  ScrollRestoration,
  useLoaderData,
  useNavigation,
  useLocation,
} from "react-router";
import { createSupabaseServerClient } from "./lib/supabase.server";
import { getMunicipality } from "./services/municipality";
import { emailAlertsAvailable, publicSignupsEnabled } from "./lib/features.server";
import { getUserProfile } from "./services/subscriptions";
import { getMunicipalityFromMatches } from "./lib/municipality-helpers";
import { ogImageUrl } from "./lib/og";

import { FlaskConical } from "lucide-react";

import type { Route } from "./+types/root";
import "./app.css";
import { Navbar } from "./components/navbar";
import { Footer } from "./components/footer";
import { PostHogProvider } from "./components/posthog-provider";
import { isAdminEmail } from "./lib/auth.server";

export const meta: Route.MetaFunction = ({ matches }) => {
  const municipality = getMunicipalityFromMatches(matches);
  const shortName = municipality?.short_name || DEFAULT_MUNICIPALITY.short_name;
  return [
    { title: `${SITE_NAME} | Council Meeting Intelligence` },
    {
      name: "description",
      content: `Searchable database of ${shortName} council meetings, voting records, and AI-powered insights.`,
    },
    { property: "og:title", content: `${SITE_NAME} | Council Meeting Intelligence` },
    {
      property: "og:description",
      content: `AI-powered civic transparency platform for the ${municipality?.name || DEFAULT_MUNICIPALITY.name}.`,
    },
    { property: "og:type", content: "website" },
    { property: "og:url", content: "https://openlangford.ca" },
    { property: "og:site_name", content: `${SITE_NAME}` },
    { property: "og:image", content: ogImageUrl("Council Meeting Intelligence") },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:image", content: ogImageUrl("Council Meeting Intelligence") },
  ];
};

export const links: Route.LinksFunction = () => [
  { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
  { rel: "icon", href: "/favicon.ico", sizes: "48x48" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap",
  },
];

export async function loader({ request, context }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  // No Supabase auth cookie means no session: skip the auth round trip for anonymous visitors.
  const hasSession = /(?:^|;\s*)sb-[^=;]*-auth-token/.test(request.headers.get("cookie") || "");
  const [user, municipality, searchBudget] = await Promise.all([
    hasSession ? supabase.auth.getUser().then(({ data }) => data.user) : Promise.resolve(null),
    getMunicipality(supabase),
    getSearchBudgetForDisplay(context.cloudflare?.env?.AI_SEARCH_DAILY_LIMIT),
  ]);

  // Redirect new users to onboarding if they haven't completed it
  if (user) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Don't redirect if already on onboarding, login, logout, signup, admin,
    // speaker review, or API routes.
    const skipRedirectPaths = ["/onboarding", "/login", "/logout", "/signup"];
    const isApiRoute = pathname.startsWith("/api/") || pathname.startsWith("/email/unsubscribe/");
    const isAdminRoute = pathname.startsWith("/admin") || pathname === "/speaker-alias";
    const shouldSkipRedirect =
      skipRedirectPaths.includes(pathname) || isApiRoute || isAdminRoute;

    if (!shouldSkipRedirect) {
      const profile = await getUserProfile(supabase, user.id);
      // No profile or onboarding not completed -> redirect to onboarding
      if (!profile || !profile.onboarding_completed) {
        throw redirect("/onboarding", { headers });
      }
    }
  }

  return {
    user,
    municipality,
    isAdmin: !!user && isAdminEmail(user.email),
    signupsEnabled: publicSignupsEnabled(),
    emailAlertsAvailable: emailAlertsAvailable(),
    aiSearchAvailable: searchBudget.available,
  };
}

export function Layout({ children }: { children: React.ReactNode }) {
  // One canonical URL per page (openlangford.ca, no query string), so the workers.dev
  // address and filtered list views aren't indexed as duplicates.
  const { pathname } = useLocation();
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {!pathname.startsWith("/email/unsubscribe/") && <link rel="canonical" href={`${SITE_ORIGIN}${pathname === "/" ? "/" : pathname.replace(/\/+$/, "")}`} />}
        <Meta />
        <Links />
        <link rel="help" type="text/markdown" href={`${SITE_ORIGIN}/agents.md`} title="Public Markdown records" />
      </head>
      <body className="antialiased">
        {children}
        <ScrollRestoration />
        <Scripts />
        {!pathname.startsWith("/email/unsubscribe/") && <PostHogProvider />}
      </body>
    </html>
  );
}

function NavigationProgress() {
  const navigation = useNavigation();
  const isLoading = navigation.state === "loading";

  if (!isLoading) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[100]">
      <div className="h-1 bg-brand-600/20">
        <div className="h-full bg-brand-600 animate-[progress_2s_ease-in-out_infinite] rounded-r-full" />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <div className="min-h-screen flex flex-col">
      <NavigationProgress />
      <div className="bg-amber-50 border-b border-amber-200 text-center text-xs text-amber-800 py-1.5 px-4">
        <span className="inline-flex items-center gap-1.5">
          This site is in beta — data may be incomplete and features are still being added.
        </span>
      </div>
      <Navbar />
      <main className="flex-1 flex flex-col">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
    let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  const is404 = isRouteErrorResponse(error) && error.status === 404;
  const is403 = isRouteErrorResponse(error) && error.status === 403;
  return (
    <div className="min-h-screen flex flex-col">
    <Navbar />
    <main className="flex-1 bg-zinc-50">
      <div className="container mx-auto max-w-xl px-4 py-24 text-center">
        <p className="text-sm font-semibold text-brand-700">{is404 ? "404" : is403 ? "403" : "Something went wrong"}</p>
        <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-zinc-900 md:text-4xl">
          {is404 ? "We couldn't find that page" : is403 ? "Access restricted" : "This page didn't load"}
        </h1>
        <p className="mt-3 text-base text-zinc-600">
          {is404
            ? "It may have moved, or the link might be wrong."
            : is403 ? "Your account does not have permission to open this page. Admin access requires an explicitly authorized account."
            : details}
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <a href="/" className="rounded-full bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
            Go home
          </a>
          <a href="/meetings" className="rounded-full border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 hover:border-brand-300 hover:text-brand-700">
            Browse meetings
          </a>
          <a href="/search" className="rounded-full border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 hover:border-brand-300 hover:text-brand-700">
            Search
          </a>
        </div>
        {stack && (
          <pre className="mt-10 w-full overflow-x-auto rounded-xl border border-zinc-200 bg-white p-4 text-left text-xs text-zinc-600">
            <code>{stack}</code>
          </pre>
        )}
      </div>
    </main>
    <Footer />
    </div>
  );
}
