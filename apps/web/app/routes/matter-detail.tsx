import { timed } from "../lib/server-timing.server";
import { TermText } from "../components/term";
import { hintPlan } from "../lib/glossary";
import { SITE_NAME } from "../lib/site-name";
import { labelSpeakerRoles } from "../services/speaker-roles.server";
import { collapseListedReadings, foldSameMeetingSteps, outcomeOf } from "../lib/timeline-story";
import { getStaffRole } from "../lib/auth.server";
import type { Route } from "./+types/matter-detail";
import {
  getMatterById,
  getDocumentsForMatter,
  getMatterEvidence,
  getMatterStory,
  type ReportMention,
} from "../services/matters";
import { createSupabaseServerClient, getSupabaseAdminClient } from "../lib/supabase.server";
import { parseRelatedAddresses } from "../lib/addresses";
import { documentImageUrl } from "../lib/document-images.server";
import { Link, data, redirect } from "react-router";
import { ReportIssueButton } from "../components/report-issue";
import { SubscribeButton } from "../components/subscribe-button";
import { firstSentence, ogImageUrl } from "../lib/og";
import { fitTitle, metaDescription, pageMeta } from "../lib/page-meta";
import { breadcrumbList, jsonLd, topicArticle } from "../lib/structured-data";
import { topicUpdatedLine } from "../lib/topic-dates";

export const meta: Route.MetaFunction = ({ data }) => {
  if (data && "removed" in data) return [{ title: `${data.removed.title} | ${SITE_NAME}` }, { name: "robots", content: "noindex" }];
  if (!data?.matter) return [{ title: `Matter | ${SITE_NAME}` }];
  const m = data.matter as any;
  const name = matterTitle(m);
  const description = m.plain_english_summary || m.description
    || `${m.category || "Council matter"} before Langford Council — ${m.status || "Active"}.`;
  const lead = (data as any)?.images?.lead;
  return [
    ...pageMeta(name, description, matterPath(m), "article", {
      fullTitle: fitTitle(name, "Langford Council"),
      image: lead?.url || ogImageUrl(name, { subtitle: firstSentence(m.plain_english_summary) || firstSentence(m.description), type: "decision" }),
      imageWidth: lead?.url ? lead.width : undefined,
      imageHeight: lead?.url ? lead.height : undefined,
    }),
    jsonLd(
      topicArticle(m, name, matterPath(m), metaDescription(description)),
      breadcrumbList([["Decisions", "/matters"], [name, matterPath(m)]]),
    ),
  ];
};
import {
  MessageSquare,
  Clock,
  Info,
  MapPin,
} from "lucide-react";
import { Badge } from "../components/ui/badge";
import { SectionHeading } from "../components/ui/section-heading";
import { cn, formatDate } from "../lib/utils";
import { displayTitle, matterTitle } from "../lib/display-text";
import { bylawLead, bylawStatus } from "../lib/bylaw-summary";
import { ParticipationList, speakersAbout } from "../components/meeting/participation-list";
import { crossNotes, writtenLetters } from "../lib/written";
import { TimelineStep, isProceduralStep } from "../components/matter/timeline-step";
import { sourcesFor } from "../services/sources.server";
import { sourceTimelineEntry, type Source } from "../lib/sources";
import { YearTimeline, FadedRow, RailItem, Disc } from "../components/timeline/chrome";
import { EntryRow } from "../components/timeline/entry-rows";
import { PullQuote } from "../components/pull-quote";
import { reportTimelineEntry } from "../lib/timeline-entry";

/** The small pill the meeting page uses for its document and vote buttons. */
import { getDocumentTypeLabel } from "../lib/document-types";
import { MattersMap } from "../components/matters-map";
import { matterStatusVariant, quietSince } from "../lib/matter-status";
import { getPropertiesForMatter, propertyPath, propertyPin, sameSiteTopics } from "../services/properties";
import { bylawPath, documentPath, matterPath, meetingPath } from "../lib/paths";
import { resolveSlugParam } from "../lib/slug-params.server";
import { loaderFailure } from "../lib/loader-errors";
import { IMAGE_KIND_LABELS } from "../lib/topic-edit";


const GENERIC_EVIDENCE_TITLES = new Set([
  "agenda",
  "agenda cover page",
  "background",
  "commentary",
  "correspondence",
  "executive summary",
  "engagement activities",
  "minutes",
  "notice of intent",
  "options",
  "page",
  "parks, recreation, and facilities",
  "proposed operating revenues",
  "proposed tax change",
  "reports",
  "significant 2026 budget items include:",
  "sports",
  "staff report",
]);

const IMAGE_CAPTION: Record<string, string> = IMAGE_KIND_LABELS;

function mentionLabel(title: string | null | undefined) {
  const t = (title || "").toLowerCase();
  if (t.includes("notice of motion")) return "Notice of motion";
  if (t.includes("public participation") || t.includes("public input") || t.includes("question period")) return "Public comment";
  if (t.includes("presentation")) return "Presentation";
  if (t.includes("delegation")) return "Delegation";
  if (t.includes("correspondence") || t.includes("petition")) return "Correspondence";
  // Another agenda item where this topic came up (a meeting's item on something else that names it).
  return "Discussed in another item";
}

/** A stored passage as plain words: source documents are markdown ("**$105,000**", stray "#"). */
function cleanQuote(value: string) {
  return value.replace(/\*\*|__/g, "").replace(/(^|\s)#+(?=\s|$)/g, "$1").replace(/\s+/g, " ").trim();
}

/** A passage that is just the item's own title adds nothing under that title. */
function quoteIsTitle(quote: string, title: string | null | undefined) {
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const q = norm(cleanQuote(quote));
  return !!title && (q === norm(title) || norm(title).includes(q));
}

function cleanEvidenceText(value: string | null | undefined) {
  return (value || "")
    .replace(/^#+\s*/gm, "")
    .replace(/\[Image[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isGenericEvidenceTitle(value: string | null | undefined) {
  const normalized = cleanEvidenceText(value)
    .replace(/^\d+(?:\.\d+)*\s*/, "")
    .replace(/^[.)\s-]+/, "")
    .toLowerCase();
  if (!normalized) return true;
  if (normalized.length < 4) return true;
  if (/^page\s+\d+$/i.test(normalized)) return true;
  if (normalized.endsWith("/") || normalized.includes("participant/")) return true;
  if (
    /^(activity|attendees|dates|engagement|where\?|who was|of participant)/i.test(normalized)
  ) {
    return true;
  }
  if (/^(city of langford\s+)?arts and cultural development strategy$/i.test(normalized)) {
    return true;
  }
  if (/^\d+\.\s*(reports|correspondence|bylaws|notices of intent)$/i.test(normalized)) {
    return true;
  }
  return GENERIC_EVIDENCE_TITLES.has(normalized);
}

function getMatterTerms(matter: any) {
  const meta = matter?.meta && typeof matter.meta === "object" ? matter.meta : {};
  const aliases = Array.isArray(meta.aliases) ? meta.aliases : [];
  return [matter?.title, ...aliases]
    .filter(Boolean)
    .map((term: string) => cleanEvidenceText(term).toLowerCase())
    .filter((term: string) => term.length >= 4);
}

function titleCaseEvidence(value: string) {
  const cleaned = cleanEvidenceText(value)
    .replace(/^\d+(?:\.\d+)*\s*/, "")
    .replace(/^[-–—:]+/, "")
    .trim();
  if (!cleaned) return "";
  return cleaned.length > 140 ? `${cleaned.slice(0, 137).trim()}...` : cleaned;
}

function findLabeledLine(sectionText: string, labels: string[]) {
  const lines = sectionText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = cleanEvidenceText(lines[i]);
    for (const label of labels) {
      const direct = line.match(new RegExp(`^${label}:\\s*(.+)$`, "i"));
      if (direct?.[1]) return titleCaseEvidence(direct[1]);
      if (line.toLowerCase() === label.toLowerCase()) {
        const next = lines.slice(i + 1).map(cleanEvidenceText).find(Boolean);
        if (next) return titleCaseEvidence(next);
      }
    }
  }
  return "";
}

function findUsefulHeading(sectionText: string, terms: string[]) {
  const headings = [...sectionText.matchAll(/^#{1,4}\s+(.+)$/gm)]
    .map((match) => titleCaseEvidence(match[1]))
    .filter((heading) => {
      if (isGenericEvidenceTitle(heading)) return false;
      const lower = heading.toLowerCase();
      if (lower.length < 12 && !terms.some((term) => lower.includes(term))) {
        return false;
      }
      return true;
    });

  const termHeading = headings.find((heading) => {
    const lower = heading.toLowerCase();
    return terms.some((term) => lower.includes(term));
  });
  return termHeading || headings[0] || "";
}

function findRelevantSentence(sectionText: string, terms: string[]) {
  const paragraphs = sectionText
    .split(/\n\s*\n/)
    .map(cleanEvidenceText)
    .filter((paragraph) => paragraph.length > 40);
  const relevant = paragraphs.find((paragraph) => {
    const lower = paragraph.toLowerCase();
    return terms.some((term) => lower.includes(term));
  }) || paragraphs[0] || "";
  if (!relevant) return "";
  // Start at the sentence that names the topic when it would otherwise fall past the cut (a long budget
  // paragraph that lists the stadium halfway through).
  const lower = relevant.toLowerCase();
  const at = Math.min(...terms.map((term) => lower.indexOf(term)).filter((i) => i >= 0));
  let start = 0;
  if (Number.isFinite(at) && at > 200) {
    const before = relevant.slice(Math.max(0, at - 160), at);
    const boundary = Math.max(before.lastIndexOf(". "), before.lastIndexOf("? "), before.lastIndexOf("! "));
    start = boundary >= 0 ? at - before.length + boundary + 2 : Math.max(0, relevant.lastIndexOf(" ", at - 80) + 1);
  }
  const shown = relevant.slice(start);
  const text = shown.length > 280 ? `${shown.slice(0, 277).trim()}...` : shown;
  return start > 0 ? `...${text}` : text;
}

function inferTitleFromRelevantText(matter: any, sectionText: string, summary: string) {
  const text = `${sectionText} ${summary}`.toLowerCase();
  const matterTitle = matter?.title || "Matter";
  const lowerMatterTitle = matterTitle.toLowerCase();
  if (lowerMatterTitle.includes("starlight stadium")) {
    if (
      text.includes("fifa world cup") ||
      text.includes("team base camp") ||
      text.includes("fifa representatives")
    ) {
      return "FIFA World Cup team base camp proposal at Starlight Stadium";
    }
    if (text.includes("commonwealth games")) {
      return "Commonwealth Games support involving Westhills Stadium";
    }
    if (text.includes("thunder bowl")) {
      return "Thunder Bowl event support at City Centre Park";
    }
    if (text.includes("telus walk to cure diabetes")) {
      return "JDRF TELUS Walk to Cure Diabetes at Westhills Stadium";
    }
    if (text.includes("canada women's sevens") || text.includes("canada women’s sevens")) {
      return "Canada Women's Sevens at Westhills Stadium";
    }
    if (text.includes("westshore rebels")) {
      return "Westshore Rebels game at Westhills Stadium";
    }
    if (text.includes("super summer kids day")) {
      return "Super Summer Kids Day at Westhills Stadium";
    }
    if (
      text.includes("arts and cultural development strategy") ||
      text.includes("community working group")
    ) {
      return "Arts and culture strategy engagement at Starlight Stadium";
    }
    if (
      text.includes("parks, recreation, and facilities") ||
      text.includes("city-owned parks, trails, and recreation infrastructure")
    ) {
      return "Parks and facilities budget reference to Starlight Stadium";
    }
  }
  if (
    lowerMatterTitle.includes("ymca") ||
    lowerMatterTitle.includes("aquatic centre")
  ) {
    if (text.includes("supplementary agreement")) {
      return "Langford Aquatic Centre supplementary agreement with YMCA/YWCA";
    }
    if (
      text.includes("langford aquatic centre debt") ||
      text.includes("woodlands park purchase") ||
      text.includes("west shore parks and recreation")
    ) {
      return "Langford Aquatic Centre debt and operating budget reference";
    }
    if (text.includes("permissive tax exemptions")) {
      return "YMCA property tax exemption reference";
    }
    if (text.includes("proposed changes to ymca-ywca services agreement")) {
      return "Proposed changes to YMCA-YWCA services agreement";
    }
    if (text.includes("purchase of service agreement")) {
      return "YMCA/YWCA services agreement contractual rights";
    }
    if (text.includes("leased to:") && text.includes("public athletic facility")) {
      return "YMCA/YWCA public athletic facility lease reference";
    }
  }
  return "";
}

function classifyEvidenceRecord(
  evidence: any,
  title: string,
  summary: string,
  sectionText: string,
) {
  const sectionTitle = evidence.document_section?.section_title || "";
  const text = `${title} ${summary} ${sectionTitle} ${sectionText}`.toLowerCase();
  if (evidence.evidence_type === "agenda_item") return "Agenda item";
  if (text.includes("moved by") || text.includes("carried")) return "Council decision";
  if (text.includes("staff report") || text.includes("department:")) return "Staff report";
  if (text.includes("budget") || text.includes("financial plan")) return "Budget";
  if (text.includes("letter") || text.includes("re:")) return "Correspondence";
  if (
    sectionTitle.toLowerCase().includes("sports") ||
    sectionTitle.toLowerCase().includes("public notices") ||
    text.includes("news gazette") ||
    text.includes("photo contributed")
  ) {
    return "Media clipping";
  }
  if (text.includes("minutes")) return "Minutes";
  return "Supporting record";
}

function buildFriendlyEvidence(evidence: any, matter: any) {
  const section = evidence.document_section;
  const agendaItem = evidence.agenda_item;
  const document = section?.document;
  const sectionText = section?.section_text || "";
  const terms = getMatterTerms(matter);
  const labeled =
    findLabeledLine(sectionText, ["Subject", "Re", "Purpose", "File No"]) ||
    findUsefulHeading(sectionText, terms);
  const summary = findRelevantSentence(sectionText, terms) || cleanEvidenceText(evidence.reason);
  const inferredTitle = inferTitleFromRelevantText(matter, sectionText, summary);
  const rawTitle =
    agendaItem?.title ||
    (!isGenericEvidenceTitle(section?.section_title) ? section?.section_title : "") ||
    (!isGenericEvidenceTitle(document?.title) ? document?.title : "");
  const title = titleCaseEvidence(inferredTitle || labeled || rawTitle || `${matter.title} supporting record`);
  return {
    title,
    summary,
    label: classifyEvidenceRecord(evidence, title, summary, sectionText),
  };
}

export async function loader({ params, request }: Route.LoaderArgs) {
  try {
    const supabase = getSupabaseAdminClient();
    const resolved = await timed("matter-resolve", resolveSlugParam(supabase, "matters", params.id, request, (m) => matterPath(m), "Matter Not Found", { redirectLegacy: false }));
    // The side queries only need the matter id, so they start together with the matter itself. They are
    // only awaited after the hidden / redirect checks below, so nothing they fetch is returned for a
    // hidden topic. A merged topic loads under its target id; that rare case refetches (see below).
    const fetchSides = (id: number) => timed("matter-sides", Promise.all([
      getMatterEvidence(supabase, id),
      getMatterStory(supabase, id),
      getPropertiesForMatter(supabase, id),
      sameSiteTopics(supabase, id),
      sourcesFor(supabase, { matterId: id }),
    ]));
    let sidesFor = Number(resolved.id);
    let sidesPromise = fetchSides(sidesFor);
    // Documents of all the matter's agenda items: also keyed on the matter id, so also started now.
    const fetchDocuments = (id: number) => { const p = timed("matter-documents", getDocumentsForMatter(supabase, id)); p.catch(() => {}); return p; };
    let documentsPromise = fetchDocuments(sidesFor);
    sidesPromise.catch(() => {}); // surfaced when awaited; never an unhandled rejection if we bail out early
    const matter = await timed("matter-load", getMatterById(supabase, String(resolved.id)));
    // Removed by staff from the review bar, or tidied away (a section heading, or a topic left with nothing on it):
    // old links get a short note (410 Gone, not indexed) pointing to the
    // meetings where its agenda items still are; staff still see the whole page, to unhide it.
    if (["staff", "container", "no_records"].includes(matter.meta?.hidden)) {
      const { data: { user } } = await createSupabaseServerClient(request).supabase.auth.getUser();
      if (!(await getStaffRole(user))) {
        // Hidden with the review bar's "Hide page" switch: simply not found.
        if (matter.meta?.hidden === "staff") throw new Response("Not Found", { status: 404, headers: { "X-Robots-Tag": "noindex" } });
        const meetings = new Map<string, { slug: string; title: string; date: string }>();
        for (const item of matter.agenda_items || []) {
          const m = (item as any).meetings;
          if (m?.slug) meetings.set(m.slug, { slug: m.slug, title: m.title, date: m.meeting_date });
        }
        return data({ removed: { title: matterTitle(matter), meetings: [...meetings.values()].sort((a, b) => a.date.localeCompare(b.date)) } },
          { status: 410, headers: { "X-Robots-Tag": "noindex" } });
      }
    }
    // Legacy ids/slugs and alias matters go straight to the canonical slug URL.
    if (matter.slug && params.id !== matter.slug) return redirect(matterPath(matter) + new URL(request.url).search, 301);

    // Fetch documents for all agenda items in this matter (batch query)
    if (matter.id !== sidesFor) { sidesFor = matter.id; sidesPromise = fetchSides(sidesFor); documentsPromise = fetchDocuments(sidesFor); }
    const [matterEvidence, story, properties, sameSite, sources] = await sidesPromise;

    // Pipeline-picked pictures from the staff reports (meta.images), resolved to public URLs.
    const pick = (img: any) => {
      const url = img ? documentImageUrl(img.r2_key) : null;
      return url ? { ...img, url } : null;
    };
    const images = { lead: pick(matter.meta?.images?.lead), layout: pick(matter.meta?.images?.layout) };
    if (images.lead?.meeting_id) {
      const known = (matter.agenda_items || []).find((ai: any) => ai.meeting_id === images.lead.meeting_id)?.meetings?.slug;
      const slug = known || (await supabase.from("meetings").select("slug").eq("id", images.lead.meeting_id).maybeSingle()).data?.slug;
      images.lead = { ...images.lead, meeting_slug: slug || null };
    }

    // Map pins from geocoded agenda items (detail queries never computed these, so no map showed).
    const pins = new Map<string, any>();
    for (const item of matter.agenda_items || []) {
      const g = (item as any).geo_location;
      if (g?.lat && g?.lng) pins.set(`${g.lat.toFixed(5)},${g.lng.toFixed(5)}`, { ...g, address: g.address || parseRelatedAddresses((item as any).related_address)[0] });
    }
    // The matter's lots (BC-geocoded) replace ingest-time pins, which were often a street fallback.
    const lots = properties.map(propertyPin).filter((p): p is NonNullable<typeof p> => p !== null);
    (matter as any).locations = lots.length ? lots : Array.from(pins.values());

    const [matterDocuments] = await Promise.all([
      documentsPromise,
      timed("matter-roles", labelSpeakerRoles(supabase, [matter, story])),
    ]);
    // Sources from outside the record, as timeline rows (their pictures resolved to public URLs here).
    const sourceRows = (sources as Source[]).map((s) => sourceTimelineEntry(s, documentImageUrl));
    return { matter, matterDocuments, matterEvidence, story, images, properties, sameSite, sourceRows };
  } catch (error) {
    throw loaderFailure(error, "Matter Not Found");
  }
}

export default function MatterDetail({ loaderData }: Route.ComponentProps) {
  if ("removed" in loaderData) return <RemovedTopic {...loaderData.removed} />;
  const { matter, matterDocuments, matterEvidence, story, images, properties = [], sameSite = [], sourceRows = [] } = loaderData;

  // Sort agenda items by meeting date
  const timeline = [...(matter.agenda_items || [])].sort(
    (a, b) =>
      new Date(b.meetings.meeting_date).getTime() -
      new Date(a.meetings.meeting_date).getTime(),
  );
  const primaryAgendaItemIds = new Set(timeline.map((item) => item.id));
  const rawEvidenceTimeline = (matterEvidence || [])
    .filter((evidence: any) => {
      if (
        evidence.evidence_type === "agenda_item" &&
        evidence.agenda_item_id &&
        primaryAgendaItemIds.has(evidence.agenda_item_id)
      ) {
        return false;
      }
      return true;
    })
    .map((evidence: any) => {
      const section = evidence.document_section;
      const agendaItem = evidence.agenda_item;
      const document = section?.document;
      const friendly = buildFriendlyEvidence(evidence, matter);
      const documentMeeting = Array.isArray(document?.meetings)
        ? document.meetings[0]
        : document?.meetings;
      const meeting = agendaItem?.meetings || documentMeeting || null;
      return {
        kind: "evidence" as const,
        key: `evidence-${evidence.id}`,
        date: meeting?.meeting_date || null,
        meetingId: agendaItem?.meeting_id || document?.meeting_id || null,
        meetingSlug: meeting?.slug || null,
        title: friendly.title,
        snippet: friendly.summary,
        label: friendly.label,
        matchCount: 1,
        evidence,
      };
    })
    .filter((entry: any) => entry.date);
  const evidenceTimeline = Array.from(
    rawEvidenceTimeline
      .reduce((groups: Map<string, any>, entry: any) => {
        const key = [
          entry.date,
          entry.meetingId || "no-meeting",
          entry.title.toLowerCase(),
        ].join("|");
        const existing = groups.get(key);
        if (!existing) {
          groups.set(key, entry);
          return groups;
        }

        existing.matchCount += 1;
        const existingConfidence = Number(existing.evidence?.confidence || 0);
        const entryConfidence = Number(entry.evidence?.confidence || 0);
        if (entryConfidence > existingConfidence) {
          existing.evidence = entry.evidence;
        }
        if (entry.snippet && entry.snippet.length > (existing.snippet || "").length) {
          existing.snippet = entry.snippet;
        }
        return groups;
      }, new Map<string, any>())
      .values(),
  );

  // Entries staff hid as repeats of another entry (meta.hidden_duplicates) stay on the topic but not in its timeline.
  const hiddenDuplicates = (matter.meta?.hidden_duplicates || {}) as Record<string, unknown>;
  // Entries borrowed from a related topic that staff (or the fix agent) took off this page one by one.
  const hiddenBackground = (matter.meta?.hidden_background || {}) as Record<string, unknown>;
  const timelineEntries = collapseListedReadings([
    ...timeline.filter((item) => !hiddenDuplicates[String(item.id)]).map((item) => ({
      kind: "primary" as const,
      key: `agenda-${item.id}`,
      date: item.meetings.meeting_date,
      item,
    })),
    ...evidenceTimeline,
    ...story.mentions
      .filter((item: any) => !primaryAgendaItemIds.has(item.id))
      .map((item: any) => ({
        kind: "mention" as const,
        key: `mention-${item.id}`,
        date: item.meetings?.meeting_date,
        item,
      })),
    ...(story.background || [])
      // Staff (or the fix agent) can take one borrowed entry off this page without unlinking its whole topic.
      .filter((item: any) => !primaryAgendaItemIds.has(item.id) && !story.mentions.some((direct: any) => direct.id === item.id)
        && !hiddenDuplicates[String(item.id)] && !hiddenBackground[String(item.id)])
      .map((item: any) => ({ kind: "mention" as const, key: `background-${item.id}`, date: item.meetings?.meeting_date, item, relatedMatter: item.relatedMatter })),
    // An annual report covers its year, so it sits at the year's end.
    ...(story.reports || []).map((report: ReportMention) => ({ kind: "report" as const, key: `report-${report.id}`, date: `${report.year}-12-31`, report })),
    // A source from outside the record (a City release, a news report), on the day it says the thing happened.
    ...sourceRows.map((row) => ({ kind: "source" as const, key: row.key, date: row.date, row })),
  ].sort(
    (a, b) => new Date(b.date || "").getTime() - new Date(a.date || "").getTime(),
  ) as any[], matter.meta?.timeline_headlines || {});
  const timelineSteps = foldSameMeetingSteps(timelineEntries, matter.meta?.timeline_headlines || {});
  // Each council term is marked inline once on the page: the status line first, then the first decision that uses it.
  // Page order: the status line, then each step's summary and its decisions, newest first.
  const termPlan = hintPlan<string>([
    { key: "status", text: matter.meta?.status_line },
    ...timelineSteps.flatMap((e: any) => [
      { key: `item-${e.item?.id}`, text: e.item?.plain_english_summary },
      ...((e.item?.motions || []) as any[]).map((m) => ({ key: `motion-${m.id}`, text: m.plain_english_summary || m.text_content })),
    ]),
  ]);

  // People who both spoke and wrote in about this matter get a note on each side.
  const aboutMatter = `${matterTitle(matter)} ${matter.plain_english_summary || ""}`;
  const matterIds: number[] = [matter.id];
  const notes = crossNotes(
    timelineEntries.flatMap((entry: any) =>
      entry.kind === "mention"
        ? speakersAbout(entry.item.meta?.participation, aboutMatter, matterIds)
        : entry.item?.meta?.participation?.speakers || [],
    ),
    timelineEntries.flatMap((entry: any) => writtenLetters(entry.item?.meta?.written_participation)),
  );

  const judgedSpeakers = (item: any) => item?.meta?.participation?.about_matters
    && matterIds.some((id) => item.meta.participation.about_matters[String(id)])
    ? speakersAbout(item.meta.participation, aboutMatter, matterIds) : [];

  // Build document lookup by agenda item ID
  const docsByItem = new Map<number, typeof matterDocuments>();
  for (const doc of matterDocuments || []) {
    if (doc.agenda_item_id != null) {
      const existing = docsByItem.get(doc.agenda_item_id);
      if (existing) {
        existing.push(doc);
      } else {
        docsByItem.set(doc.agenda_item_id, [doc]);
      }
    }
  }

  // Preserve this proceeding's dates; related background is not its lifecycle.
  const directEntries = timelineEntries.filter(entry => !("relatedMatter" in entry));
  const lastSeen = directEntries.length > 0 ? directEntries[0].date : null;
  const firstSeen =
    directEntries.length > 0
      ? directEntries[directEntries.length - 1].date
      : null;

  // Addresses that share the same other topics are one card ("3044, 3108 and 3127 Glen Lake Road"), and topics already
  // shown under Background aren't repeated for every address.
  // Topics shown under Related topics or "Also at" above aren't repeated here.
  const relatedIds = new Set([...(story.related || []).map((r: any) => r.id), ...sameSite.map((m) => m.id)]);
  const addressGroups = (() => {
    const groups = new Map<string, { key: string; properties: any[]; others: any[]; relatedHere: boolean }>();
    for (const p of properties as any[]) {
      const others = (p.others || []).filter((m: any) => !relatedIds.has(m.id));
      const key = others.map((m: any) => m.id).sort((a: number, b: number) => a - b).join(",") || "none";
      const group = groups.get(key) ?? { key, properties: [] as any[], others, relatedHere: false };
      // Topics here that are listed under Related topics: then "no other matters" would be wrong.
      if ((p.others || []).some((m: any) => relatedIds.has(m.id))) group.relatedHere = true;
      group.properties.push(p);
      groups.set(key, group);
    }
    // Within a card, addresses on the same street read "2614, 2616 and 2618 Peatt Road; 2622 Sunderland Road".
    const streetOf = (address: string) => String(address).replace(/^[\d\-–A-Za-z]*\d[A-Za-z]?\s+/, "");
    return [...groups.values()].map((g) => {
      const byStreet = new Map<string, any[]>();
      for (const p of g.properties) byStreet.set(streetOf(p.address), [...(byStreet.get(streetOf(p.address)) || []), p]);
      const num = (p: any) => parseInt(String(p.address), 10) || 0;
      return { ...g, streets: [...byStreet].map(([street, props]) => ({
        street, properties: [...props].sort((a, b) => num(a) - num(b)),
        number: (p: any) => String(p.address).slice(0, String(p.address).length - street.length).trim() || p.address,
      })) };
    });
  })();
  const statusVariant = matterStatusVariant(matter.status);
  const shortDate = (d: string | null | undefined) =>
    d
      ? formatDate(d, { year: "numeric", month: "short", day: "numeric" })
      : "";

  const photoAndMap = !!images.lead && (matter.locations?.length ?? 0) > 0;
  const updatedLine = topicUpdatedLine(matter);

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-4xl px-4 pt-6 pb-12 md:pt-10">
        <header className="mb-10">
          {/* Above the title, the status badge and the page's buttons share a row. */}
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              {statusVariant ? (
                <Badge variant={statusVariant}>{matter.status}</Badge>
              ) : quietSince(matter.status, lastSeen || matter.last_seen) ? (
                <Badge variant="muted">No activity since {quietSince(matter.status, lastSeen || matter.last_seen)}</Badge>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <ReportIssueButton />
              <SubscribeButton type="matter" targetId={matter.id} label="Follow" icon />
            </div>
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight text-zinc-900 md:text-4xl">{matterTitle(matter)}</h1>

          {(matter.plain_english_summary || matter.description) && (
            <p id="topic-summary" className="mt-4 max-w-2xl text-base leading-relaxed text-zinc-700">
              {matter.plain_english_summary || matter.description}
            </p>
          )}

          {/* The status line, under the summary; it carries its own date (without one, when the topic first came up). */}
          {(matter.meta?.status_line || firstSeen) && (
            <div id="topic-status" className="mt-4 max-w-2xl rounded-r-lg border-l-2 border-brand-500 bg-brand-50 py-2 pl-3 pr-4">
              {/* The label on its own line, in the border's colour, so a long status wraps cleanly under itself. */}
              <p className="text-xs font-semibold text-brand-700">Status</p>
              <p className="mt-0.5 text-sm leading-relaxed text-zinc-700">
                <TermText text={matter.meta?.status_line || `First discussed ${formatDate(firstSeen!, { month: "short", year: "numeric" })}`} only={termPlan.get("status")} />
              </p>
            </div>
          )}

          {sameSite.length > 0 && (
            // Earlier or later applications for the same land: a rezoning, then another rezoning or a variance years on.
            <div id="topic-same-site" className="mt-4 rounded-2xl border border-zinc-200 bg-surface px-5 py-4 shadow-sm">
              <p className="text-sm font-semibold text-zinc-900">
                Also at {new Set(sameSite.map((m) => m.address)).size === 1 ? sameSite[0].address : "this site"}
              </p>
              <ul className="mt-1.5 space-y-1">
                {sameSite.slice(0, 4).map((m) => (
                  <li key={m.id} className="flex items-baseline gap-2 text-sm">
                    <Link to={matterPath(m)} className="min-w-0 text-zinc-700 hover:text-brand-700 hover:underline">
                      {m.title}
                    </Link>
                    {m.status && matterStatusVariant(m.status) && <Badge variant={matterStatusVariant(m.status)!} className="shrink-0">{m.status}</Badge>}
                  </li>
                ))}
              </ul>
              {sameSite.length > 4 && (
                <Link to={propertyPath(properties[0])} className="mt-1.5 inline-block text-sm font-medium text-brand-700 hover:underline">
                  See all {sameSite.length + 1} at {properties[0]?.address}
                </Link>
              )}
            </div>
          )}

          {(matter.identifier || updatedLine) && (
            // File and bylaw numbers, for anyone looking up the City's own records; and when the page last
            // changed, if that was well after its latest meeting (otherwise the meeting date says it).
            <p className="mt-3 text-xs text-zinc-500">
              {[matter.identifier && `Reference: ${matter.identifier}`, updatedLine].filter(Boolean).join(" · ")}
            </p>
          )}

          {images.lead && (
            // With a map too, the picture and the map share a row (stacked on a phone) instead of two tall blocks.
            <div className={cn("mt-6", photoAndMap && "grid gap-4 md:grid-cols-2")}>
            <figure>
              <a href={images.lead.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-2xl border border-zinc-200 bg-surface">
                <img
                  src={images.lead.url}
                  alt={`${IMAGE_CAPTION[images.lead.kind] || "From the staff report"}: ${matterTitle(matter)}`}
                  width={images.lead.width}
                  height={images.lead.height}
                  className={cn("w-full object-cover", photoAndMap ? "h-[260px] sm:h-[320px]" : "max-h-[420px]")}
                  loading="eager"
                />
              </a>
              <figcaption className="mt-2 text-xs text-zinc-500">
                {/* "What's proposed · from the staff report"; a picture with no kind is just "From the staff report". */}
                {IMAGE_CAPTION[images.lead.kind] ? `${IMAGE_CAPTION[images.lead.kind]} · from the staff report` : "From the staff report"}
                {images.lead.meeting_id && images.lead.document_id ? (
                  <>
                    {" "}·{" "}
                    <Link to={documentPath({ id: images.lead.meeting_id, slug: images.lead.meeting_slug }, images.lead.document_id)} className="text-brand-700 hover:underline">
                      View report
                    </Link>
                  </>
                ) : null}
              </figcaption>
            </figure>
            {photoAndMap && <MattersMap compact short matters={[matter]} activeLocation={matter.locations?.[0]} />}
            </div>
          )}

          {[matter.bylaw, ...((matter as any).other_bylaws || [])].filter(Boolean).map((bylaw: any, index: number, bylaws: any[]) => (
            <div key={bylaw.id} className={cn("rounded-2xl border border-zinc-200 bg-surface p-5 shadow-sm", index === 0 ? "mt-6" : "mt-3")}>
              <p className="mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-zinc-500">
                {[
                  bylaws.length > 1 ? "Bylaw" : "Governing bylaw",
                  bylaw.bylaw_number ? `No. ${bylaw.bylaw_number}` : null,
                  bylawStatus(bylaw.status)?.label ?? null,
                ]
                  .filter(Boolean)
                  .map((part, i) => (
                    <span key={i} className="inline-flex items-center gap-1.5 tabular-nums">
                      {i > 0 && <span aria-hidden="true" className="text-zinc-300">·</span>}
                      {part}
                    </span>
                  ))}
              </p>
              <Link
                to={bylawPath(bylaw)}
                className="block text-base font-semibold leading-snug text-zinc-900 hover:text-brand-700"
              >
                {displayTitle(bylaw.title)}
              </Link>
              {bylawLead(bylaw.plain_english_summary) && (
                <p className="mt-1.5 text-sm leading-relaxed text-zinc-600">
                  {bylawLead(bylaw.plain_english_summary)}
                </p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm font-semibold">
                <Link to={bylawPath(bylaw)} className="text-brand-700 hover:text-brand-800">
                  Key rules and full text
                </Link>
                <a
                  href={bylaw.source_url || `/api/bylaws/${bylaw.id}/download`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-zinc-600 hover:text-brand-700"
                >
                  Official PDF
                </a>
              </div>
            </div>
          ))}
        </header>

        <div className="space-y-12">
          {((!photoAndMap && matter.locations && matter.locations.length > 0) || properties.length > 0) && (
            <section>
              <SectionHeading title="Location" icon={MapPin} />
              {!photoAndMap && matter.locations && matter.locations.length > 0 && (
                <MattersMap matters={[matter]} activeLocation={matter.locations?.[0]} />
              )}
              {addressGroups.length > 0 && (
                <ul className={cn("space-y-3", matter.locations?.length && !photoAndMap ? "mt-4" : "")}>
                  {addressGroups.map((g) => (
                    <li key={g.key} className="rounded-2xl border border-zinc-200 bg-surface p-4 shadow-sm">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <span className="font-semibold text-zinc-900">
                          {g.streets.map((st, si) => (
                            <span key={st.street + si}>
                              {si > 0 && "; "}
                              {st.properties.map((p: any, i: number) => (
                                <span key={p.id}>
                                  {i > 0 && (i === st.properties.length - 1 ? " and " : ", ")}
                                  <Link to={propertyPath(p)} className="hover:text-brand-700">{st.properties.length > 1 ? st.number(p) : p.address}</Link>
                                </span>
                              ))}
                              {st.properties.length > 1 && <> {st.street}</>}
                            </span>
                          ))}
                        </span>
                        {!(g.others.length === 0 && g.relatedHere) && (
                          <span className="text-sm text-zinc-500">
                            {g.others.length === 0
                              ? `Nothing else at ${g.properties.length > 1 ? "these addresses" : "this address"}`
                              : `${g.others.length} other ${g.others.length === 1 ? "topic" : "topics"} at ${g.properties.length > 1 ? "these addresses" : "this address"}`}
                          </span>
                        )}
                      </div>
                      {g.others.length > 0 && (
                        <ul className="mt-2 space-y-1.5">
                          {g.others.slice(0, 4).map((m: any) => (
                            <li key={m.id} className="flex items-baseline gap-3 text-sm">
                              <span className="w-12 shrink-0 tabular-nums text-xs text-zinc-400">
                                {String(m.last_seen || m.first_seen || "").slice(0, 4)}
                              </span>
                              <Link to={matterPath(m)} className="min-w-0 text-zinc-700 hover:text-brand-700 hover:underline">
                                {matterTitle(m)}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                      {g.others.length > 4 && g.properties.length === 1 && (
                        <Link to={propertyPath(g.properties[0])} className="mt-2 inline-block text-sm font-medium text-brand-700 hover:underline">
                          See all {g.others.length + 1} at {g.properties[0].address}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {story.related.length > 0 && (
            <section>
              <SectionHeading
                title="Related topics"
                description="Other topics about the same place or project."
              />
              <ol className="overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm divide-y divide-zinc-100">
                {story.related.map((r: any) => (
                  <li key={r.id} data-review-entry={`related-${r.id}`}>
                    <Link to={matterPath(r)} className="group block px-5 py-4 hover:bg-zinc-50">
                      <p className="text-xs tabular-nums text-zinc-500">
                        {r.first_seen ? shortDate(r.first_seen) : ""}
                        {r.last_seen && r.last_seen !== r.first_seen ? ` – ${shortDate(r.last_seen)}` : ""}
                      </p>
                      <p className="mt-0.5 font-semibold leading-snug text-zinc-900 group-hover:text-brand-700">
                        {matterTitle(r)}
                      </p>
                      {(r.meta?.status_line || r.plain_english_summary) && (
                        <p className="mt-1 text-sm leading-relaxed text-zinc-600 line-clamp-2">
                          {r.plain_english_summary || r.meta?.status_line}
                        </p>
                      )}
                    </Link>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <section>
            <SectionHeading
              title="Timeline"
              icon={Clock}
              description="Every time this came up at council, in the City's reports, or in what was said elsewhere, newest first. Each line says who said it."
            />

            {timelineEntries.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-zinc-200 bg-surface px-6 py-12 text-center text-sm text-zinc-500">
                No meeting records are linked to this matter yet.
              </div>
            ) : (
              <>
                <YearTimeline rows={timelineSteps} dateOf={(e: any) => e.date}>
                  {(entry: any) => {
                    // Staff-approved wording for a linked entry (the fix agent, quoting the record) replaces the generated text.
                    const override: { line?: string; heading?: string } | undefined = matter.meta?.entry_lines?.[entry.key];
                    if (entry.kind === "report") {
                      const report: ReportMention = entry.report;
                      return (
                        <EntryRow key={entry.key} entry={reportTimelineEntry(report, { headline: override?.line || cleanQuote(report.quote), lead: override?.heading, quoted: !override?.line })} />
                      );
                    }
                    // A source from outside the record (a City release, a news report): the same row an address's timeline draws.
                    if (entry.kind === "source") return <EntryRow key={entry.key} entry={entry.row} />;
                    if (entry.kind === "mention") {
                      const item = entry.item;
                      return (
                        <FadedRow key={entry.key} id={entry.key}>
                          <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
                            <Link to={meetingPath({ id: item.meeting_id, slug: item.meetings?.slug })} className="tabular-nums hover:text-brand-700">
                              {formatDate(item.meetings?.meeting_date)}
                            </Link>
                            <span className="text-zinc-300">·</span>
                            {entry.relatedMatter ? (
                              <span>Part of <Link to={matterPath(entry.relatedMatter)} className="font-medium text-zinc-700 hover:text-brand-700">{matterTitle(entry.relatedMatter)}</Link></span>
                            ) : item.linkSource === "name_mention" ? (
                              // Only mentioned here: the other item is context, the quote is the entry.
                              <span>
                                {mentionLabel(item.title) === "Discussed in another item" ? "Mentioned" : mentionLabel(item.title)}
                                {!/^public participation$/i.test((item.title || "").trim()) && <> during <span className="italic">{displayTitle(item.title)}</span></>}
                              </span>
                            ) : <span>{mentionLabel(item.title)}</span>}
                          </div>
                          {override?.heading ? (
                            <p className="mb-1 text-sm font-medium text-zinc-700">{override.heading}</p>
                          ) : (entry.relatedMatter || (item.linkQuote && item.linkSource !== "name_mention")) && <p className="mb-1 text-sm font-medium text-zinc-700">{displayTitle(item.title)}</p>}
                          {override?.line ? (
                            <p className="text-sm leading-relaxed text-zinc-600">{override.line}</p>
                          ) : judgedSpeakers(item).length > 0 ? (
                            // Public comment judged speaker by speaker: only those who spoke about this topic.
                            <ParticipationList speakers={judgedSpeakers(item)} note={notes.speaker} className="mt-1" />
                          ) : item.linkQuote && !quoteIsTitle(item.linkQuote, item.title) ? (
                            // Found by name: the passage that names this matter, not the item's own summary.
                            <PullQuote>“{cleanQuote(item.linkQuote)}”</PullQuote>
                          ) : (() => {
                            const about = speakersAbout(item.meta?.participation, aboutMatter, matterIds);
                            return about.length > 0 ? (
                              <ParticipationList speakers={about} note={notes.speaker} className="mt-1" />
                            ) : (
                              item.plain_english_summary && (
                                <p className="text-sm leading-relaxed text-zinc-600">{item.plain_english_summary}</p>
                              )
                            );
                          })()}
                        </FadedRow>
                      );
                    }
                    if (entry.kind === "evidence") {
                      return (
                        <FadedRow key={entry.key} id={entry.key}>
                          <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
                            {entry.meetingId ? (
                              <Link
                                to={meetingPath({ id: entry.meetingId, slug: entry.meetingSlug })}
                                className="tabular-nums hover:text-brand-700"
                              >
                                {formatDate(entry.date)}
                              </Link>
                            ) : (
                              <span className="tabular-nums">
                                {formatDate(entry.date)}
                              </span>
                            )}
                            <Badge variant="muted">{entry.label}</Badge>
                            {entry.matchCount > 1 && (
                              <span className="tabular-nums">
                                {entry.matchCount} references
                              </span>
                            )}
                          </div>
                          <h4 className="text-sm font-semibold leading-snug text-zinc-900">
                            {override?.heading || displayTitle(entry.title)}
                          </h4>
                          {(override?.line || entry.snippet) && (
                            <p className="mt-1 line-clamp-3 text-sm leading-relaxed text-zinc-600">
                              {override?.line || entry.snippet}
                            </p>
                          )}
                        </FadedRow>
                      );
                    }

                    const item = entry.item;
                    // A report folded into this step (same meeting) brings its documents.
                    const itemDocs = [item, ...(entry.folded || [])].flatMap((i: any) => docsByItem.get(i.id) || []);
                    // Pipeline-written plain-English headline; the agenda wording lives in Details.
                    const headline: string | undefined = matter.meta?.timeline_headlines?.[String(item.id)];
                    const layout = images.layout && images.layout.agenda_item_id === item.id ? images.layout : null;
                    const chosenStage: string | undefined = (item as any).meta?.staff_stage?.stage;
                    // A routine step is a faded card; a step with its own story (a hearing, speakers, a picture) is a full one.
                    const procedural = isProceduralStep(item, {
                      hasParticipation: Boolean(
                        (item as any).meta?.participation?.speakers?.length ||
                          writtenLetters((item as any).meta?.written_participation).length,
                      ),
                      hasImage: Boolean(layout),
                      headline,
                      stage: chosenStage,
                    });
                    return (
                      // The dot takes the colour of how the decision went; with no decision it is filled for a full card
                      // and hollow for a faded one, so the dot always matches the card's weight.
                      <RailItem key={entry.key} id={entry.key} dot={<Disc outcome={outcomeOf(item.motions)} decided={!procedural} />}>
                        <TimelineStep
                          item={item}
                          headline={headline}
                          chosenStage={chosenStage}
                          docs={itemDocs}
                          layoutImage={layout}
                          participation={(item as any).meta?.participation}
                          written={(item as any).meta?.written_participation}
                          notes={notes}
                          termHints={termPlan}
                        />
                      </RailItem>
                    );
                  }}
                </YearTimeline>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/** A topic staff removed: say so, and point to where its agenda items still are. */
function RemovedTopic({ title, meetings }: { title: string; meetings: { slug: string; title: string; date: string }[] }) {
  return (
    <div className="container mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-2xl font-bold text-zinc-900">{title}</h1>
      <p className="mt-3 text-zinc-600">
        This topic page was removed from Open Langford because there wasn't enough on record to follow it as a topic.
        {meetings.length > 0 && " The agenda items it covered are still on their meeting pages."}
      </p>
      {meetings.length > 0 && (
        <ul className="mt-4 space-y-1">
          {meetings.map((m) => (
            <li key={m.slug}>
              <Link to={`/meetings/${m.slug}`} className="font-medium text-brand-700 hover:underline">{m.title}</Link>
              <span className="text-sm text-zinc-500"> · {formatDate(m.date)}</span>
            </li>
          ))}
        </ul>
      )}
      <Link to="/matters" className="mt-6 inline-block text-sm font-medium text-brand-700 hover:underline">Browse all topics</Link>
    </div>
  );
}
