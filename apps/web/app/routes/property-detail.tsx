import { Link, useFetcher, useRouteLoaderData } from "react-router";
import { requireModerator } from "../lib/auth.server";
import { AdminOnly } from "../components/ui/admin-only";
import { Clock, FileText, Landmark, MapPin } from "lucide-react";
import type { Route } from "./+types/property-detail";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { unavailable } from "../lib/loader-errors";
import { getPropertyBySlug, propertyPath } from "../services/properties";
import { MattersMap } from "../components/matters-map";
import { RecordsSparkline } from "../components/records-sparkline";
import { Badge } from "../components/ui/badge";
import { DetailHeader } from "../components/ui/detail-header";
import { SectionHeading } from "../components/ui/section-heading";
import { displayTitle, matterTitle } from "../lib/display-text";
import { matterStatusVariant } from "../lib/matter-status";
import { matterPath, meetingPath } from "../lib/paths";
import { SITE_NAME } from "../lib/site-name";
import { firstSentence, ogImageUrl } from "../lib/og";
import { metaDescription, pageMeta } from "../lib/page-meta";
import { breadcrumbList, jsonLd, propertyPlace } from "../lib/structured-data";
import { cn, formatDate } from "../lib/utils";
import { notFoundIfHidden } from "../services/page-visibility.server";
import { documentImageUrl } from "../lib/document-images.server";
import { propertyTimeline } from "../services/property-timeline.server";
import { PropertyTimeline, type TimelineEntry } from "../components/property/property-timeline";

export const meta: Route.MetaFunction = ({ data }) => {
  if (!data?.property) return [{ title: `Property | ${SITE_NAME}` }];
  const { property, matters, isStreet } = data;
  // The page's lead is its search description too: the pipeline's property-summaries stage
  // writes it (what happened there, then how often it came up); the title carries "Langford".
  const summary: string | undefined = (property as any).meta?.summary || topicsLead(matters) || undefined;
  const description = summary
    ? summary
    : isStreet
    ? `Road work, developments and other council decisions on ${property.address}, Langford, newest first.`
    : matters.length
    ? `Council decisions and projects at ${property.address}, Langford: ${matters
        .slice(0, 3)
        .map((m: any) => matterTitle(m))
        .join("; ")}.`
    : `Council meetings that mentioned ${property.address}, Langford.`;
  const path = propertyPath(property);
  return [
    ...pageMeta(`${property.address}, Langford`, description, path, "article", {
      image: ogImageUrl(property.address, {
        subtitle: firstSentence(summary) || matters.slice(0, 2).map((m: any) => matterTitle(m)).join(" · ") || undefined,
        type: isStreet ? "street" : "property",
      }),
    }),
    // Nothing on the page, or only a resident's home address from public input (see getPropertyBySlug).
    ...(data.noindex ? [{ name: "robots", content: "noindex, follow" }] : []),
    jsonLd(
      // A lot pinned only to its street has no coordinates of its own.
      propertyPlace({ address: property.address, geo: property.civic_number && (property.geo as any)?.precision === "street" ? null : (property.geo as any) }, path, metaDescription(description)),
      breadcrumbList([["Properties", "/properties"], [property.address, path]]),
    ),
  ];
};

// Session-free (so the edge can share it, signed in or not): the admin flag comes from the root loader.
export async function loader({ params, request }: Route.LoaderArgs) {
  // getPropertyBySlug throws on a failed query and returns null only when no row matched.
  const result = await getPropertyBySlug(getSupabaseAdminClient(), params.slug).catch((error) => { throw unavailable(error); });
  if (!result) throw new Response("Property Not Found", { status: 404 });
  await notFoundIfHidden(request, "properties", result.property.id);
  // Each topic's picture from its staff report (the pipeline's pick, matters.meta.images), as a public URL.
  const images: Record<number, string> = {};
  for (const m of result.matters as any[]) {
    const url = documentImageUrl(m.meta?.images?.lead?.r2_key ?? m.meta?.images?.layout?.r2_key);
    if (url) images[m.id] = url;
  }
  // One chronology for a lot: topic steps, other entries, annual reports, outside sources and closed meetings.
  const timeline: TimelineEntry[] = result.isStreet ? [] : await propertyTimeline(getSupabaseAdminClient(), result.property as any, result.matters, result.items, documentImageUrl);
  return { ...result, images, timeline };
}

/** Admins remove a wrong link (the address parser misread a title). The pipeline keeps it hidden. */
export async function action({ request, params }: Route.ActionArgs) {
  await requireModerator(request);
  const form = await request.formData();
  const supabase = getSupabaseAdminClient();
  const { data: property } = await supabase.from("properties").select("id").eq("slug", params.slug).maybeSingle();
  if (!property) return { error: "Unknown property." };
  const matterId = Number(form.get("matter_id")) || null;
  const itemId = Number(form.get("agenda_item_id")) || null;
  if (!matterId && !itemId) return { error: "Nothing to unlink." };
  let query = supabase.from("property_links").update({ hidden: true }).eq("property_id", property.id);
  query = matterId ? query.eq("matter_id", matterId) : query.eq("agenda_item_id", itemId!);
  const { error } = await query;
  return error ? { error: error.message } : { ok: true };
}

function Unlink({ field, id, isStreet }: { field: "matter_id" | "agenda_item_id"; id: number; isStreet: boolean }) {
  const fetcher = useFetcher<typeof action>();
  if (fetcher.state !== "idle" || (fetcher.data as any)?.ok) return <AdminOnly><span className="text-xs text-zinc-500">Removed</span></AdminOnly>;
  return (
    <AdminOnly>
      <fetcher.Form method="post">
        <input type="hidden" name={field} value={id} />
        <button type="submit" className="text-xs font-medium text-amber-900 hover:text-red-700 hover:underline">
          Remove from this {isStreet ? "street" : "address"}
        </button>
      </fetcher.Form>
    </AdminOnly>
  );
}

const shortDate = (d: string | null | undefined) => (d ? formatDate(d, { year: "numeric", month: "short", day: "numeric" }) : "");

/** A lead built from the topics at the address when the pipeline has not written one: the newest topic's first
 * sentence, its status line, and for a second topic its first sentence too. Exported for tests. */
export function topicsLead(matters: any[]): string {
  const parts: string[] = [];
  for (const m of matters.slice(0, 2)) {
    const first = firstSentence(m.plain_english_summary || "") || "";
    if (first) parts.push(first.replace(/([^.!?])$/, "$1."));
    if (parts.length === 1 && m.meta?.status_line) parts.push(String(m.meta.status_line).replace(/([^.!?])$/, "$1."));
  }
  return parts.join(" ");
}

export default function PropertyDetail({ loaderData }: Route.ComponentProps) {
  const { property, matters, items, nearby, lots, isStreet, streetSlug, activity, images, timeline } = loaderData;
  const isAdmin = !!(useRouteLoaderData("root") as { isAdmin?: boolean } | undefined)?.isAdmin;
  const geo = property.geo as { lat: number; lng: number } | null;
  // The pipeline's lead, or, until it has written one, what the records themselves say: the newest topic's first
  // sentence and where it stands, never a line about the page.
  const summary: string | undefined = (property as any).meta?.summary || topicsLead(matters) || undefined;
  const dates = [...matters.flatMap((m: any) => [m.first_seen, m.last_seen]), ...items.map((i: any) => i.meetings?.meeting_date)]
    .filter(Boolean)
    .sort();
  // A street's span includes its lots, matching the sparkline.
  if (isStreet && activity.length) dates.splice(0, dates.length, String(activity[0].year), String(activity.at(-1)!.year));
  // The map draws matters at their locations; every matter here is at this lot.
  // A street page pins each lot that has coordinates instead.
  const pins = isStreet
    ? lots.filter((l: any) => l.geo).map((l: any) => ({ id: l.id, slug: l.slug, title: l.address, locations: [{ ...l.geo, address: l.address }] }))
    : geo
      ? matters.map((m: any) => ({ ...m, locations: [{ ...geo, address: property.address }] }))
      : [];

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-4xl px-4 pt-6 pb-12 md:pt-10">
        <DetailHeader
          back={{ to: "/properties", label: "Properties" }}
          meta={[
            <span key="kind">{isStreet ? "Street" : "Property"}</span>,
            dates.length > 0 ? (
              <span key="dates" className="tabular-nums">
                In council meetings {String(dates[0]).slice(0, 4)}
                {String(dates.at(-1)).slice(0, 4) !== String(dates[0]).slice(0, 4) ? `–${String(dates.at(-1)).slice(0, 4)}` : ""}
              </span>
            ) : null,
          ]}
          title={property.address}
          className="mb-6"
          actions={activity.length > 1 ? <RecordsSparkline data={activity} /> : undefined}
          description={
            summary ||
            (isStreet
              ? `What Council has decided about ${property.address} and the addresses on it, from road work to new homes.`
              : matters.length > 0
              ? "Everything Council has decided about this address, newest first. Developments that cover several lots appear on each lot's page."
              : "Council meetings that mentioned this address.")
          }
        />

        <div className="space-y-12">
          {pins.length > 0 && (
            <section>
              <div>
                <MattersMap
                  compact
                  bleed
                  fitToMarkers={isStreet}
                  matters={pins as any}
                  activeLocation={isStreet ? undefined : geo || undefined}
                  {...(isStreet ? { hrefFor: (lot: any) => propertyPath(lot), linkLabel: "View address" } : {})}
                />
              </div>
            </section>
          )}

          {!isStreet && timeline.length > 0 && (
            <section>
              <SectionHeading title="Timeline" icon={Clock}
                description="Everything the records hold about this address, in order: Council's steps, what else named it, the City's reports, and what was said elsewhere. Each line says who said it." />
              <PropertyTimeline entries={timeline}
                renderAdmin={(e) => (isAdmin && e.kind === "mention" ? <Unlink field="agenda_item_id" id={Number(e.key.slice(5))} isStreet={false} /> : null)} />
            </section>
          )}

          {matters.length > 0 && (
            <section>
              <SectionHeading
                title={isStreet ? "About the street" : "Topics at this address"}
                icon={Landmark}
                description={isStreet ? "Road work, closures and other decisions about the street itself." : "Each rezoning, permit or project here has its own page."}
              />
              <ol className={cn(isStreet ? "divide-y divide-zinc-100 overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm" : "grid gap-4", !isStreet && matters.length > 1 && "sm:grid-cols-2")}>
                {matters.map((m: any) => {
                  const variant = matterStatusVariant(m.status);
                  const image = images?.[m.id];
                  const summary = m.plain_english_summary ? (firstSentence(m.plain_english_summary) || m.plain_english_summary).replace(/([^.!?])$/, "$1.") : null;
                  // Keyed for the review bar (matter-<id>): the check flags an entry by this key and the bar outlines it.
                  return (
                    <li key={m.id} id={`timeline-matter-${m.id}`} data-review-entry={`matter-${m.id}`}
                      className={cn(!isStreet && "overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm transition-shadow hover:shadow-md")}>
                      <div className="flex h-full flex-col">
                      <Link to={matterPath(m)} className="group flex flex-1 gap-4 px-5 py-4 hover:bg-zinc-50">
                        <div className="min-w-0 flex-1">
                          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-zinc-500">
                            <span>
                              {shortDate(m.first_seen)}
                              {m.last_seen && m.last_seen !== m.first_seen ? ` – ${shortDate(m.last_seen)}` : ""}
                            </span>
                            {m.category && <span className="text-zinc-400">· {m.category}</span>}
                            {variant && <Badge variant={variant}>{m.status}</Badge>}
                          </p>
                          <p className="mt-0.5 font-semibold leading-snug text-zinc-900 group-hover:text-brand-700">{matterTitle(m)}</p>
                          {/* What it is, then where it stands: the topic's own summary and status line. */}
                          {summary && <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-zinc-600">{summary}</p>}
                          {m.meta?.status_line && <p className="mt-1 text-xs text-zinc-500">{m.meta.status_line}</p>}
                        </div>
                        {image && (
                          <img src={image} alt="" loading="lazy" className="hidden h-24 w-32 shrink-0 rounded-lg border border-zinc-200 object-cover sm:block" />
                        )}
                      </Link>
                      {isAdmin && (
                        <div className="-mt-2 px-5 pb-3">
                          <Unlink field="matter_id" id={m.id} isStreet={isStreet} />
                        </div>
                      )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}


          {isStreet && items.length > 0 && (
            <section>
              <SectionHeading title="Other mentions" icon={FileText} description="Other times this address came up in council meetings." />
              <ul className="divide-y divide-zinc-100 overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
                {items.map((item: any) => (
                  <li key={item.id} id={`timeline-item-${item.id}`} data-review-entry={`item-${item.id}`}>
                    <div>
                    <Link to={`${meetingPath(item.meetings)}#item-${item.id}`} className="group block px-5 py-4 hover:bg-zinc-50">
                      <p className="text-xs tabular-nums text-zinc-500">
                        {shortDate(item.meetings?.meeting_date)} · {item.meetings?.title}
                      </p>
                      <p className="mt-0.5 font-medium leading-snug text-zinc-900 group-hover:text-brand-700">{displayTitle(item.title)}</p>
                      {item.plain_english_summary && (
                        <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-zinc-600">{item.plain_english_summary}</p>
                      )}
                    </Link>
                    {isAdmin && (
                      <div className="-mt-2 px-5 pb-3">
                        <Unlink field="agenda_item_id" id={item.id} isStreet={isStreet} />
                      </div>
                    )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {lots.length > 0 && (
            <section>
              <SectionHeading title="Addresses on this street" icon={MapPin} />
              <ul className="grid gap-x-6 sm:grid-cols-2">
                {lots.map((l: any) => (
                  <li key={l.slug} className="flex items-baseline justify-between gap-3 border-b border-zinc-100 py-2 text-sm">
                    <Link to={propertyPath(l)} className="font-medium text-zinc-800 hover:text-brand-700 hover:underline">
                      {l.address}
                    </Link>
                    <span className="shrink-0 tabular-nums text-xs text-zinc-500">
                      {l.mentions === 1 ? "Mentioned once" : `Mentioned ${l.mentions} times`}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {nearby.length > 0 && (
            <section>
              <SectionHeading
                title="Nearby"
                icon={MapPin}
                description={
                  nearby[0].lot.distance != null
                    ? "What Council has considered around this address, closest first."
                    : `What Council has considered at neighbouring addresses on ${property.street}.`
                }
              />
              <ul className="divide-y divide-zinc-100 overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
                {nearby.map((m: any) => {
                  const variant = matterStatusVariant(m.status);
                  return (
                    <li key={m.id} className="px-5 py-3.5">
                      <Link to={matterPath(m)} className="font-medium leading-snug text-zinc-900 hover:text-brand-700 hover:underline">
                        {matterTitle(m)}
                      </Link>
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
                        <Link to={propertyPath(m.lot)} className="font-medium text-zinc-600 hover:text-brand-700 hover:underline">
                          {m.lot.address}
                        </Link>
                        {m.lot.distance != null && <span className="tabular-nums">· {m.lot.distance < 1000 ? `${Math.max(10, Math.round(m.lot.distance / 10) * 10)} m` : `${(m.lot.distance / 1000).toFixed(1)} km`}</span>}
                        {(m.last_seen || m.first_seen) && <span className="tabular-nums">· {String(m.last_seen || m.first_seen).slice(0, 4)}</span>}
                        {variant && <Badge variant={variant}>{m.status}</Badge>}
                      </p>
                    </li>
                  );
                })}
              </ul>
              {streetSlug && (
                <Link to={propertyPath({ slug: streetSlug })} className="mt-3 inline-block text-sm font-semibold text-brand-700 hover:underline">
                  Everything on {property.street}
                </Link>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
