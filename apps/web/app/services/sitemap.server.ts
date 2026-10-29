import type { SupabaseClient } from "@supabase/supabase-js";
import type { SitemapEntry } from "../lib/sitemap";
import { latestDate, sitemapDate } from "../lib/sitemap";
import { bylawPath, documentPath, electionPath, matterPath, meetingDocumentsPath, meetingPath } from "../lib/paths";
import { propertyPath } from "./properties";
import { participantPath, personPath } from "../lib/people-paths";
import { getMunicipality } from "./municipality";
import { getPublicParticipantStats } from "./people";
import { getPublicParticipationHistories } from "./public-participation.server";
import { cachedCompute, HOURLY_SHARED } from "./computed-cache.server";
import { publicData } from "./public-data-cache.server";

/**
 * URL lists for /sitemap.xml, one section per content type. Each mirrors the
 * visibility rules of its page: public-ready meetings only, canonical non-hidden
 * matters, council members under /people and everyone else under /participants.
 */
export const SITEMAP_SECTIONS = ["pages", "meetings", "documents", "matters", "properties", "bylaws", "people", "participants", "elections"] as const;
export type SitemapSection = (typeof SITEMAP_SECTIONS)[number];

// Same rule as the meetings list/detail pages (services/meetings.ts PUBLIC_READY_FILTER).
const PUBLIC_READY_FILTER = "has_agenda.eq.true,has_minutes.eq.true,has_transcript.eq.true,summary.not.is.null";

async function pageAll<T = any>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 1000) return out;
  }
}

async function publicMeetings(supabase: SupabaseClient, municipalityId: number) {
  return pageAll<any>((from, to) =>
    supabase
      .from("meetings")
      .select("id, slug, meeting_date, updated_at, has_transcript")
      .eq("municipality_id", municipalityId)
      .or(PUBLIC_READY_FILTER)
      .order("id")
      .range(from, to),
  );
}

/** Per-section lastmod for /sitemap.xml: the newest entry in each section (from the same cache). */
export async function sitemapIndexEntries(supabase: SupabaseClient, today = sitemapDate(new Date().toISOString())!): Promise<{ path: string; lastmod: string | null }[]> {
  return Promise.all(
    SITEMAP_SECTIONS.map(async (section) => {
      const entries = await sitemapEntries(supabase, section).catch((error) => {
        console.error(`Sitemap section ${section} failed:`, error);
        return [] as SitemapEntry[];
      });
      // Scheduled meetings carry future dates; a section can't have changed after today.
      const dates = entries.map((e) => sitemapDate(e.lastmod)).filter((d): d is string => !!d && d <= today);
      return { path: `/sitemaps/${section}.xml`, lastmod: latestDate(...dates) };
    }),
  );
}

export async function sitemapEntries(supabase: SupabaseClient, section: SitemapSection): Promise<SitemapEntry[]> {
  const municipality = await getMunicipality(supabase);
  // Store only the public URL projection, never XML/root/session responses.
  // Corrections use the shared deployment/content version; expiry bounds
  // pipeline changes which have not yet published a new content version.
  return publicData(`sitemap:${municipality.id}:${section}`,
    () => buildSitemapEntries(supabase, section, municipality), () => true, 3600, { shareWithSignedIn: true });
}

async function buildSitemapEntries(
  supabase: SupabaseClient,
  section: SitemapSection,
  municipality: Awaited<ReturnType<typeof getMunicipality>>,
): Promise<SitemapEntry[]> {
  switch (section) {
    case "pages":
      return [
        { path: "/", changefreq: "daily", priority: 1 },
        { path: "/meetings", changefreq: "daily", priority: 0.9 },
        { path: "/matters", changefreq: "daily", priority: 0.9 },
        { path: "/properties", changefreq: "weekly", priority: 0.8 },
        { path: "/bylaws", changefreq: "weekly", priority: 0.8 },
        { path: "/people", changefreq: "weekly", priority: 0.8 },
        { path: "/participants", changefreq: "weekly", priority: 0.6 },
        { path: "/elections", changefreq: "monthly", priority: 0.6 },
        { path: "/alignment", changefreq: "weekly", priority: 0.5 },
        { path: "/about", changefreq: "monthly", priority: 0.4 },
        { path: "/contact", changefreq: "yearly", priority: 0.2 },
        { path: "/privacy", changefreq: "yearly", priority: 0.1 },
        { path: "/terms", changefreq: "yearly", priority: 0.1 },
      ];

    case "meetings": {
      const meetings = await publicMeetings(supabase, municipality.id);
      const docMeetings = new Set<number>();
      for (let i = 0; i < meetings.length; i += 300) {
        const ids = meetings.slice(i, i + 300).map((m) => m.id);
        const rows = await pageAll<any>((from, to) => supabase.from("documents").select("meeting_id").in("meeting_id", ids).range(from, to));
        for (const r of rows) docMeetings.add(r.meeting_id);
      }
      const today = sitemapDate(new Date().toISOString())!;
      return meetings.flatMap((m) => {
        // A scheduled meeting's date is when it happens, not when its page changed.
        const lastmod = latestDate(m.updated_at, m.meeting_date <= today ? m.meeting_date : null);
        const out: SitemapEntry[] = [{ path: meetingPath(m), lastmod, changefreq: "monthly", priority: 0.7 }];
        if (docMeetings.has(m.id)) out.push({ path: meetingDocumentsPath(m), lastmod, changefreq: "monthly", priority: 0.4 });
        if (m.has_transcript) out.push({ path: meetingPath(m, "/explorer"), lastmod, changefreq: "monthly", priority: 0.3 });
        return out;
      });
    }

    case "documents": {
      const meetings = new Map((await publicMeetings(supabase, municipality.id)).map((m) => [m.id, m]));
      const docs = await pageAll<any>((from, to) =>
        supabase.from("extracted_documents").select("id, created_at, documents!inner(meeting_id)").order("id").range(from, to),
      );
      return docs.flatMap((d) => {
        const meeting = meetings.get(d.documents?.meeting_id);
        return meeting ? [{ path: documentPath(meeting, d.id), lastmod: latestDate(d.created_at), changefreq: "yearly" as const, priority: 0.4 }] : [];
      });
    }

    case "matters": {
      const matters = await pageAll<any>((from, to) =>
        supabase
          .from("matters")
          .select("id, slug, first_seen, last_seen")
          .eq("municipality_id", municipality.id)
          .is("meta->>canonical_matter_id", null)
          .is("meta->>hidden", null)
          .order("id")
          .range(from, to),
      );
      // updated_at is touched by bulk backfills; last_seen is the latest meeting that took the matter up.
      return matters.map((m) => ({ path: matterPath(m), lastmod: latestDate(m.last_seen || m.first_seen), changefreq: "weekly" as const, priority: 0.7 }));
    }

    case "bylaws": {
      const bylaws = await pageAll<any>((from, to) =>
        supabase.from("bylaws").select("id, slug, updated_at").eq("municipality_id", municipality.id).order("id").range(from, to),
      );
      return bylaws.map((b) => ({ path: bylawPath(b), lastmod: latestDate(b.updated_at), changefreq: "monthly" as const, priority: 0.6 }));
    }

    case "properties": {
      // Only pages with something on them: an address with a visible record, or a
      // street with one itself or at any of its addresses (hidden links leave thin pages).
      const [properties, links] = await Promise.all([
        pageAll<any>((from, to) =>
          supabase.from("properties").select("id, slug, street, civic_number").eq("municipality_id", municipality.id).order("id").range(from, to),
        ),
        pageAll<any>((from, to) =>
          supabase
            .from("property_links")
            .select("id, property_id, agenda_items(meetings(meeting_date)), matters(last_seen)")
            .eq("hidden", false)
            .order("id")
            .range(from, to),
        ),
      ]);
      // lastmod = the latest meeting that considered the address (properties.updated_at is a backfill stamp).
      const latest = new Map<number, string | null>();
      for (const l of links) latest.set(l.property_id, latestDate(latest.get(l.property_id), l.agenda_items?.meetings?.meeting_date, l.matters?.last_seen));
      const streetLatest = new Map<string, string | null>();
      for (const p of properties) {
        if (!latest.has(p.id)) continue;
        const street = String(p.street).toLowerCase();
        streetLatest.set(street, latestDate(streetLatest.get(street), latest.get(p.id)));
      }
      return properties
        .filter((p) => latest.has(p.id) || (p.civic_number === "" && streetLatest.has(String(p.street).toLowerCase())))
        .map((p) => ({
          path: propertyPath(p),
          // A street page lists its lots, so it changes whenever any of them does.
          lastmod: p.civic_number === "" ? latestDate(latest.get(p.id), streetLatest.get(String(p.street).toLowerCase())) : latest.get(p.id) ?? null,
          changefreq: "monthly" as const,
          priority: p.civic_number === "" ? 0.6 : 0.5,
        }));
    }

    case "people": {
      // Council service = a membership in a Council-classified organization (lib/council-service.ts).
      const people = await pageAll<any>((from, to) =>
        supabase
          .from("people")
          .select("id, slug, updated_at, memberships!inner(organization:organizations!inner(classification))")
          .eq("memberships.organization.classification", "Council")
          .order("id")
          .range(from, to),
      );
      return people.flatMap((p) => {
        const lastmod = latestDate(p.updated_at);
        return [
          { path: personPath(p), lastmod, changefreq: "weekly" as const, priority: 0.8 },
          { path: personPath(p, "/votes"), lastmod, changefreq: "weekly" as const, priority: 0.5 },
          { path: personPath(p, "/proposals"), lastmod, changefreq: "weekly" as const, priority: 0.5 },
        ];
      });
    }

    case "participants": {
      // Same computation (and cache entry) as the /participants page.
      const participants = await cachedCompute(`public-participants:${municipality.id}`, () =>
        getPublicParticipantStats(supabase, municipality.id, getPublicParticipationHistories(municipality.slug)),
        HOURLY_SHARED,
      );
      return (participants as any[])
        .filter((p) => p?.person?.slug || p?.person?.id)
        .map((p) => ({
          path: participantPath(p.person),
          lastmod: latestDate(...(p.recentAppearances || []).map((a: any) => a.meetingDate || a.date)),
          changefreq: "monthly" as const,
          priority: 0.3,
        }));
    }

    case "elections": {
      const elections = await pageAll<any>((from, to) => supabase.from("elections").select("id, slug, election_date, updated_at").order("id").range(from, to));
      return elections.map((e) => ({ path: electionPath(e), lastmod: latestDate(e.updated_at, e.election_date), changefreq: "yearly" as const, priority: 0.5 }));
    }
  }
}
