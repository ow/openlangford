import { Link, useFetcher, useRouteLoaderData } from "react-router";
import { requireAdmin } from "../lib/auth.server";
import { AdminOnly } from "../components/ui/admin-only";
import { FileText, Landmark, MapPin } from "lucide-react";
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
import { ogImageUrl } from "../lib/og";
import { metaDescription, pageMeta } from "../lib/page-meta";
import { breadcrumbList, jsonLd, propertyPlace } from "../lib/structured-data";
import { formatDate } from "../lib/utils";

export const meta: Route.MetaFunction = ({ data }) => {
  if (!data?.property) return [{ title: `Property | ${SITE_NAME}` }];
  const { property, matters } = data;
  // The pipeline's property-summaries stage writes a plain-language overview for addresses with 2+ records.
  const summary: string | undefined = (property as any).meta?.summary || undefined;
  const description = summary
    ? `${property.address}, Langford: ${summary}`
    : matters.length
    ? `${matters.length} council ${matters.length === 1 ? "matter" : "matters"} about ${property.address}, Langford: ${matters
        .slice(0, 3)
        .map((m: any) => matterTitle(m))
        .join("; ")}.`
    : `Council records that mention ${property.address}, Langford.`;
  const path = propertyPath(property);
  return [
    ...pageMeta(`${property.address}, Langford`, description, path, "article", {
      image: ogImageUrl(property.address, { subtitle: data.isStreet ? "Street" : "Property", type: "matter" }),
    }),
    jsonLd(
      // A lot pinned only to its street has no coordinates of its own.
      propertyPlace({ address: property.address, geo: property.civic_number && (property.geo as any)?.precision === "street" ? null : (property.geo as any) }, path, metaDescription(description)),
      breadcrumbList([["Properties", "/properties"], [property.address, path]]),
    ),
  ];
};

// Session-free (so the edge can share it, signed in or not): the admin flag comes from the root loader.
export async function loader({ params }: Route.LoaderArgs) {
  // getPropertyBySlug throws on a failed query and returns null only when no row matched.
  const result = await getPropertyBySlug(getSupabaseAdminClient(), params.slug).catch((error) => { throw unavailable(error); });
  if (!result) throw new Response("Property Not Found", { status: 404 });
  return result;
}

/** Admins remove a wrong link (the address parser misread a title). The pipeline keeps it hidden. */
export async function action({ request, params }: Route.ActionArgs) {
  await requireAdmin(request);
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

export default function PropertyDetail({ loaderData }: Route.ComponentProps) {
  const { property, matters, items, nearby, lots, isStreet, streetSlug, activity } = loaderData;
  const isAdmin = !!(useRouteLoaderData("root") as { isAdmin?: boolean } | undefined)?.isAdmin;
  const geo = property.geo as { lat: number; lng: number } | null;
  const summary: string | undefined = (property as any).meta?.summary || undefined;
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
                In council records {String(dates[0]).slice(0, 4)}
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
              ? `${lots.length} ${lots.length === 1 ? "address" : "addresses"} on ${property.address} in council records${
                  matters.length || items.length ? `, plus ${matters.length + items.length} about the street itself` : ""
                }.`
              : matters.length > 0
              ? `Everything Council considered about this lot: ${matters.length} ${matters.length === 1 ? "matter" : "matters"}${
                  items.length ? ` and ${items.length} other agenda ${items.length === 1 ? "item" : "items"}` : ""
                }. Developments that span several lots also appear on each lot's page.`
              : "Agenda items that named this address.")
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

          {matters.length > 0 && (
            <section>
              <SectionHeading
                title={isStreet ? "About the street" : "Matters"}
                icon={Landmark}
                description={isStreet ? "Road works, closures and other matters about the street itself." : "Applications, permits and bylaws for this address, most recent first."}
              />
              <ol className="divide-y divide-zinc-100 overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
                {matters.map((m: any) => {
                  const variant = matterStatusVariant(m.status);
                  return (
                    <li key={m.id}>
                      <Link to={matterPath(m)} className="group block px-5 py-4 hover:bg-zinc-50">
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-zinc-500">
                          <span>
                            {shortDate(m.first_seen)}
                            {m.last_seen && m.last_seen !== m.first_seen ? ` – ${shortDate(m.last_seen)}` : ""}
                          </span>
                          {m.category && <span className="text-zinc-400">· {m.category}</span>}
                          {variant && <Badge variant={variant}>{m.status}</Badge>}
                        </p>
                        <p className="mt-0.5 font-semibold leading-snug text-zinc-900 group-hover:text-brand-700">{matterTitle(m)}</p>
                        {(m.meta?.status_line || m.plain_english_summary) && (
                          <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-zinc-600">{m.meta?.status_line || m.plain_english_summary}</p>
                        )}
                      </Link>
                      {isAdmin && (
                        <div className="-mt-2 px-5 pb-3">
                          <Unlink field="matter_id" id={m.id} isStreet={isStreet} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            </section>
          )}

          {items.length > 0 && (
            <section>
              <SectionHeading title="Other mentions" icon={FileText} description="Agenda items that named this address outside any matter." />
              <ul className="divide-y divide-zinc-100 overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
                {items.map((item: any) => (
                  <li key={item.id}>
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
                      {l.records} {l.records === 1 ? "record" : "records"}
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
