import { SITE_NAME } from "../lib/site-name";
import { DEFAULT_MUNICIPALITY } from "../lib/site-config";
import { PageHeader } from "../components/ui/page-header";
import { NativeSelect } from "../components/ui/native-select";
import { FilterBar } from "../components/ui/filter-bar";
import { SearchField } from "../components/ui/search-field";
import { useState } from "react";
import type { Route } from "./+types/people";
import { getMunicipalityFromMatches } from "../lib/municipality-helpers";
import { ogImageUrl, ogUrl } from "../lib/og";

export const meta: Route.MetaFunction = ({ matches }) => {
  const municipality = getMunicipalityFromMatches(matches);
  const shortName = municipality?.short_name || DEFAULT_MUNICIPALITY.short_name;
  const description = `${shortName} council members, attendance records, and voting history.`;
  return [
    { title: `Council Members | ${SITE_NAME}` },
    { name: "description", content: description },
    { property: "og:title", content: `Council Members | ${SITE_NAME}` },
    { property: "og:description", content: description },
    { property: "og:type", content: "website" },
    { property: "og:url", content: ogUrl("/people") },
    { property: "og:image", content: ogImageUrl("Council members", { subtitle: `Votes, attendance and motions for every ${shortName} council member`, type: "council" }) },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { name: "twitter:card", content: "summary_large_image" },
  ];
};
import { getPublicCouncilSummary } from "../services/council-summary.server";
import { getMunicipality } from "../services/municipality";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { councilTermStatus, councilTermLabel, councilRoster, membershipIsActiveOn } from "../lib/council-terms";
import type { Municipality } from "../lib/types";
import { Link, useRouteLoaderData, useSearchParams } from "react-router";
import { Users, Search } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { PersonCard } from "../components/person-card";
import { formatDate } from "../lib/utils";

export async function loader() {
  const supabase = getSupabaseAdminClient();
  const municipality = await getMunicipality(supabase);
  return getPublicCouncilSummary(municipality.id);
}

export default function PeopleList({ loaderData }: Route.ComponentProps) {
  const { people, terms, today, stats: statsByTerm } = loaderData;
  const rootData = useRouteLoaderData("root") as { municipality?: Municipality } | undefined;
  const shortName = rootData?.municipality?.short_name || "Council";
  const [searchTerm, setSearchTerm] = useState("");
  const [params, setParams] = useSearchParams();
  const current = terms.find((term) => councilTermStatus(term, today) === "current");
  const selected = terms.find((term) => String(term.id) === params.get("term")) || current || terms[0];
  const status = selected ? councilTermStatus(selected, today) : null;
  // Without verified term dates, show only dated current memberships and no invented term.
  const range = selected || { start_date: "0001-01-01", end_date: null };
  const roster = councilRoster(people, range, today)
    .filter(({ person, status: memberStatus }) =>
      person.name.toLowerCase().includes(searchTerm.toLowerCase()) && (selected || memberStatus === "current"))
    .sort((a, b) => {
      const mayorA = a.memberships.some((membership) => membership.role === "Mayor");
      const mayorB = b.memberships.some((membership) => membership.role === "Mayor");
      return Number(mayorB) - Number(mayorA) || a.person.name.localeCompare(b.person.name);
    });
  const members = roster.filter((member) => status !== "current" || member.status !== "past");
  const formerMembers = status === "current" ? roster.filter((member) => member.status === "past") : [];

  const renderMembers = (entries: typeof roster) => entries.map(({ person, memberships, status: memberStatus }) => {
    const membership = memberships.find((m) => membershipIsActiveOn(m, today)) || memberships[0];
    const role = membership?.role || "Council member";
    const displayRole = (person as any).in_memoriam
      ? "In memoriam"
      : memberStatus === "upcoming" ? `${role}-elect` : memberStatus === "past" ? `Former ${role.toLowerCase()}` : role;
    const stats = statsByTerm[String(selected?.id ?? "current")][person.id];
    return <PersonCard key={person.id} person={{ ...person, stats }} role={displayRole} showStats={memberStatus !== "upcoming"} />;
  });

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto flex max-w-5xl flex-col gap-8 px-4 pt-6 pb-12 md:pt-10">
        <PageHeader
          className="pb-0"
          title={`${shortName} Council`}
          icon={Users}
          description="Who serves, who has been elected, and the record of each council term."
          actions={
            <>
              <Link className="rounded-full border border-zinc-200 bg-surface px-3 py-1.5 text-sm font-semibold text-zinc-700 transition-colors hover:border-brand-300 hover:text-brand-700" to="/elections">Elections</Link>
              <Link className="rounded-full border border-zinc-200 bg-surface px-3 py-1.5 text-sm font-semibold text-zinc-700 transition-colors hover:border-brand-300 hover:text-brand-700" to={`/alignment${selected ? `?term=${selected.id}` : ""}`}>Voting alignment</Link>
            </>
          }
        />
        <FilterBar
          sticky={false}
          className="mb-0"
          search={
            <SearchField
              aria-label="Search council members"
              placeholder="Search members"
              value={searchTerm}
              onValueChange={setSearchTerm}
            />
          }
          controls={
          <NativeSelect id="council-term" aria-label="Council term" className="w-full sm:w-80" value={selected?.id || ""} disabled={!terms.length} onChange={(event) => { const next = new URLSearchParams(params); next.set("term", event.target.value); setParams(next, { preventScrollReset: true }); }}>
            {!terms.length && <option value="">Current council · term dates unavailable</option>}
            {terms.map((term) => <option key={term.id} value={term.id}>{councilTermLabel(term, today)}</option>)}
          </NativeSelect>
          }
        />
        <section className="flex flex-col gap-4" aria-labelledby="selected-term-heading">
          <div className="flex flex-col gap-2">
            <p id="selected-term-heading" className="flex flex-wrap items-center gap-2 text-sm text-zinc-500">
              {status === "upcoming" && <Badge variant="brand">Incoming</Badge>}
              {selected ? (
                <span>
                  {status === "upcoming" ? "Takes office " : "Term began "}
                  {formatDate(selected.start_date)}
                  {selected.end_date ? ` · Ends ${formatDate(selected.end_date)}` : ""}
                </span>
              ) : (
                <span>Members serving today</span>
              )}
            </p>
            {status === "upcoming" && <p className="text-sm text-muted-foreground">Election results identify the incoming council. Members currently serving remain in office until the new term begins. There are no attendance or voting statistics for this term yet.</p>}
            {!selected && <p className="text-sm text-muted-foreground">Verified term dates have not been recorded. Only members serving today are shown.</p>}
          </div>
          <div className="grid gap-4">{renderMembers(members)}</div>
          {!members.length && <p className="py-6 text-muted-foreground">No members match this selection.</p>}
        </section>
        {!!formerMembers.length && <section className="flex flex-col gap-4"><h2 className="text-lg font-bold tracking-tight text-zinc-900">Also served during this term</h2><p className="text-sm text-zinc-500">Members who served part of this term.</p><div className="grid gap-4">{renderMembers(formerMembers)}</div></section>}
      </div>
    </div>
  );
}
