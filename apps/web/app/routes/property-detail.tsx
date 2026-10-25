import { Link } from "react-router";
import { FileText, Landmark, MapPin } from "lucide-react";
import type { Route } from "./+types/property-detail";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { getPropertyBySlug, propertyPath } from "../services/properties";
import { MattersMap } from "../components/matters-map";
import { Badge } from "../components/ui/badge";
import { DetailHeader } from "../components/ui/detail-header";
import { SectionHeading } from "../components/ui/section-heading";
import { displayTitle, matterTitle } from "../lib/display-text";
import { matterStatusVariant } from "../lib/matter-status";
import { matterPath, meetingPath } from "../lib/paths";
import { SITE_NAME } from "../lib/site-name";
import { ogImageUrl, ogUrl } from "../lib/og";
import { formatDate } from "../lib/utils";

export const meta: Route.MetaFunction = ({ data }) => {
  if (!data?.property) return [{ title: `Property | ${SITE_NAME}` }];
  const { property, matters } = data;
  const title = `${property.address} | ${SITE_NAME}`;
  const description = matters.length
    ? `${matters.length} council ${matters.length === 1 ? "matter" : "matters"} about ${property.address}, Langford: ${matters
        .slice(0, 3)
        .map((m: any) => matterTitle(m))
        .join("; ")}.`
    : `Council records that mention ${property.address}, Langford.`;
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: property.address },
    { property: "og:description", content: description },
    { property: "og:type", content: "article" },
    { property: "og:url", content: ogUrl(propertyPath(property)) },
    { property: "og:image", content: ogImageUrl(property.address, { subtitle: "Property", type: "matter" }) },
    { name: "twitter:card", content: "summary_large_image" },
  ];
};

export async function loader({ params }: Route.LoaderArgs) {
  const result = await getPropertyBySlug(getSupabaseAdminClient(), params.slug);
  if (!result) throw new Response("Property Not Found", { status: 404 });
  return result;
}

const shortDate = (d: string | null | undefined) => (d ? formatDate(d, { year: "numeric", month: "short", day: "numeric" }) : "");

export default function PropertyDetail({ loaderData }: Route.ComponentProps) {
  const { property, matters, items, neighbours } = loaderData;
  const geo = property.geo as { lat: number; lng: number } | null;
  const dates = [...matters.flatMap((m: any) => [m.first_seen, m.last_seen]), ...items.map((i: any) => i.meetings?.meeting_date)]
    .filter(Boolean)
    .sort();
  // The map draws matters at their locations; every matter here is at this lot.
  const pins = geo ? matters.map((m: any) => ({ ...m, locations: [{ ...geo, address: property.address }] })) : [];

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-4xl px-4 py-12">
        <DetailHeader
          back={{ to: "/matters", label: "Matters" }}
          meta={[
            <span key="kind">Property</span>,
            dates.length > 0 ? (
              <span key="dates" className="tabular-nums">
                In council records {String(dates[0]).slice(0, 4)}
                {String(dates.at(-1)).slice(0, 4) !== String(dates[0]).slice(0, 4) ? `–${String(dates.at(-1)).slice(0, 4)}` : ""}
              </span>
            ) : null,
          ]}
          title={property.address}
          description={
            matters.length > 0
              ? `Everything Council considered about this lot: ${matters.length} ${matters.length === 1 ? "matter" : "matters"}${
                  items.length ? ` and ${items.length} other agenda ${items.length === 1 ? "item" : "items"}` : ""
                }. Developments that span several lots also appear on each lot's page.`
              : "Agenda items that named this address."
          }
        />

        <div className="space-y-12">
          {pins.length > 0 && (
            <section>
              <div className="overflow-hidden rounded-2xl border border-zinc-200 shadow-sm">
                <MattersMap matters={pins as any} activeLocation={geo!} />
              </div>
            </section>
          )}

          {matters.length > 0 && (
            <section>
              <SectionHeading title="Matters" icon={Landmark} description="Applications, permits and bylaws for this address, most recent first." />
              <ol className="divide-y divide-zinc-100 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
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
                    </li>
                  );
                })}
              </ol>
            </section>
          )}

          {items.length > 0 && (
            <section>
              <SectionHeading title="Other mentions" icon={FileText} description="Agenda items that named this address outside any matter." />
              <ul className="divide-y divide-zinc-100 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
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
                  </li>
                ))}
              </ul>
            </section>
          )}

          {neighbours.length > 0 && (
            <section>
              <SectionHeading title={`Nearby on ${property.street}`} icon={MapPin} />
              <div className="flex flex-wrap gap-2">
                {neighbours.map((n: any) => (
                  <Link
                    key={n.slug}
                    to={propertyPath(n)}
                    className="rounded-full border border-zinc-200 bg-white px-3 py-1 text-sm text-zinc-700 hover:border-brand-300 hover:text-brand-700"
                  >
                    {n.address}
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
