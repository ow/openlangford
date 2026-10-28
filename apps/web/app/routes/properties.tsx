import { Link } from "react-router";
import { useMemo, useState } from "react";
import { CalendarClock, MapPin, Search, Signpost } from "lucide-react";
import type { Route } from "./+types/properties";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { getPropertiesIndex, propertyPath, type PropertyIndexEntry } from "../services/properties";
import { publicData } from "../services/public-data-cache.server";
import { MattersMap } from "../components/matters-map";
import { Input } from "../components/ui/input";
import { PageHeader, PAGE_CONTAINER } from "../components/ui/page-header";
import { SectionHeading } from "../components/ui/section-heading";
import { DEFAULT_MUNICIPALITY } from "../lib/site-config";
import { SITE_NAME } from "../lib/site-name";
import { ogImageUrl, ogUrl } from "../lib/og";
import { displayTitle } from "../lib/display-text";
import { meetingPath } from "../lib/paths";
import { formatDate } from "../lib/utils";

const DESCRIPTION = `Every ${DEFAULT_MUNICIPALITY.short_name} address and street named in council records: rezonings, permits, variances and road works, by location.`;
const TOP = 30;
const MATCHES = 100;

export const meta: Route.MetaFunction = () => [
  { title: `Properties | ${SITE_NAME}` },
  { name: "description", content: DESCRIPTION },
  { property: "og:title", content: `Properties | ${SITE_NAME}` },
  { property: "og:description", content: DESCRIPTION },
  { property: "og:type", content: "website" },
  { property: "og:url", content: ogUrl("/properties") },
  { property: "og:image", content: ogImageUrl("Properties", { subtitle: "Addresses in council records", type: "matter" }) },
  { name: "twitter:card", content: "summary_large_image" },
];

export async function loader() {
  // The pipeline's properties stage changes this a few times a day at most.
  return publicData("properties-index", () => getPropertiesIndex(getSupabaseAdminClient()), (v) => v.lots.length > 0, 3600);
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

function AddressList({ lots }: { lots: PropertyIndexEntry[] }) {
  return (
    <ul className="grid gap-x-6 sm:grid-cols-2">
      {lots.map((lot) => (
        <li key={lot.slug} className="flex items-baseline justify-between gap-3 border-b border-zinc-100 py-2 text-sm">
          <Link to={propertyPath(lot)} className="font-medium text-zinc-800 hover:text-brand-700 hover:underline">
            {lot.address}
          </Link>
          <span className="shrink-0 tabular-nums text-xs text-zinc-500">{plural(lot.records, "record")}</span>
        </li>
      ))}
    </ul>
  );
}

function RecentlyInCouncil({ recent }: { recent: Route.ComponentProps["loaderData"]["recent"] }) {
  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
      <SectionHeading title="Recently in council" icon={CalendarClock} description="The latest agenda items that named an address." />
      <ol className="grid gap-x-8 gap-y-4 md:grid-cols-2">
        {recent.map(({ item, meeting, properties }) => (
          <li key={item.id} className="min-w-0">
            <p className="flex flex-wrap gap-x-2 text-sm font-semibold">
              {properties.slice(0, 3).map((p) => (
                <Link key={p.slug} to={propertyPath(p)} className="text-zinc-900 hover:text-brand-700 hover:underline">
                  {p.address}
                </Link>
              ))}
              {properties.length > 3 && <span className="font-normal text-zinc-500">+{properties.length - 3} more</span>}
            </p>
            <Link to={`${meetingPath(meeting)}#item-${item.id}`} className="group mt-0.5 block text-sm leading-snug">
              <span className="line-clamp-2 text-zinc-700 group-hover:text-brand-700">{displayTitle(item.title)}</span>
              <span className="text-xs tabular-nums text-zinc-500">
                {formatDate(meeting.meeting_date, { year: "numeric", month: "short", day: "numeric" })} · {meeting.title}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default function Properties({ loaderData }: Route.ComponentProps) {
  const { lots, streets, recent } = loaderData;
  const [filterText, setFilterText] = useState("");
  const query = filterText.trim().toLowerCase();

  const pins = useMemo(
    () =>
      lots
        .filter((lot) => lot.geo)
        .map((lot) => ({ id: lot.slug, slug: lot.slug, title: `${lot.address} · ${plural(lot.records, "record")}`, locations: [{ ...lot.geo!, address: lot.address }] })),
    [lots],
  );
  const matchingLots = useMemo(() => (query ? lots.filter((lot) => lot.address.toLowerCase().includes(query)) : []), [lots, query]);
  const matchingStreets = useMemo(() => (query ? streets.filter((s) => s.address.toLowerCase().includes(query)) : streets), [streets, query]);

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className={`${PAGE_CONTAINER} py-12`}>
        <PageHeader
          title="Properties"
          icon={MapPin}
          description={`${plural(lots.length, "address")} and ${plural(streets.length, "street")} named in council records. Each page gathers every matter and agenda item about that place.`}
          actions={
            <div className="relative w-full md:w-72">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <Input
                placeholder="Find an address or street"
                aria-label="Find an address or street"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                className="bg-white pl-9"
              />
            </div>
          }
        />

        <div className="space-y-12">
          {recent.length > 0 && <RecentlyInCouncil recent={recent} />}

          {pins.length > 0 && (
            <section>
              <MattersMap compact tall matters={pins as any} hrefFor={(lot: any) => propertyPath(lot)} linkLabel="View address" />
              <p className="mt-2 text-xs text-zinc-500">
                {plural(pins.length, "address")} with a known location. Numbered circles group nearby addresses; zoom in to explore.
              </p>
            </section>
          )}

          <section>
            <SectionHeading title={query ? "Matching addresses" : "Most discussed addresses"} icon={MapPin} description={query ? undefined : "Addresses with the most matters and agenda items. Search above to find any address."} />
            {query && matchingLots.length === 0 ? (
              <p className="text-sm text-zinc-500">No addresses match &ldquo;{filterText}&rdquo;.</p>
            ) : (
              <>
                <AddressList lots={(query ? matchingLots : lots).slice(0, query ? MATCHES : TOP)} />
                {query && matchingLots.length > MATCHES && (
                  <p className="mt-3 text-sm text-zinc-500">
                    Showing the {MATCHES} with the most records of {matchingLots.length.toLocaleString()}. Add a house number to narrow it down.
                  </p>
                )}
              </>
            )}
          </section>

          <section>
            <SectionHeading title="Streets" icon={Signpost} description="A street's page lists every address on it in council records, plus matters about the street itself." />
            {matchingStreets.length === 0 ? (
              <p className="text-sm text-zinc-500">No streets match &ldquo;{filterText}&rdquo;.</p>
            ) : (
              <ul className="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
                {matchingStreets.map((street) => (
                  <li key={street.slug} className="flex items-baseline justify-between gap-3 border-b border-zinc-100 py-2 text-sm">
                    <Link to={propertyPath(street)} className="font-medium text-zinc-800 hover:text-brand-700 hover:underline">
                      {street.address}
                    </Link>
                    {street.lots > 0 && <span className="shrink-0 tabular-nums text-xs text-zinc-500">{plural(street.lots, "address")}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
