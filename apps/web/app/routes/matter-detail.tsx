import { SITE_NAME } from "../lib/site-name";
import type { Route } from "./+types/matter-detail";
import {
  getMatterById,
  getDocumentsForAgendaItems,
  getMatterEvidence,
  getMatterStory,
} from "../services/matters";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { parseRelatedAddresses } from "../lib/addresses";
import { documentImageUrl } from "../lib/document-images.server";
import { Link, redirect } from "react-router";
import { SubscribeButton } from "../components/subscribe-button";
import { ogImageUrl } from "../lib/og";
import { fitTitle, pageMeta } from "../lib/page-meta";
import { breadcrumbList, jsonLd } from "../lib/structured-data";

export const meta: Route.MetaFunction = ({ data }) => {
  if (!data?.matter) return [{ title: `Matter | ${SITE_NAME}` }];
  const m = data.matter as any;
  const name = matterTitle(m);
  const description = m.plain_english_summary || m.description
    || `${m.category || "Council matter"} before Langford Council — ${m.status || "Active"}.`;
  const lead = (data as any)?.images?.lead;
  return [
    ...pageMeta(name, description, matterPath(m), "article", {
      fullTitle: fitTitle(name, "Langford Council"),
      image: lead?.url || ogImageUrl(m.title, { subtitle: m.status, type: "matter" }),
      imageWidth: lead?.url ? lead.width : undefined,
      imageHeight: lead?.url ? lead.height : undefined,
    }),
    jsonLd(breadcrumbList([["Matters", "/matters"], [name, matterPath(m)]])),
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
import { DetailHeader } from "../components/ui/detail-header";
import { cn, formatDate } from "../lib/utils";
import { displayTitle, matterTitle } from "../lib/display-text";
import { bylawLead, bylawStatus } from "../lib/bylaw-summary";
import { ParticipationList, speakersAbout } from "../components/meeting/participation-list";
import { crossNotes, writtenLetters } from "../lib/written";
import { TimelineStep, isProceduralStep } from "../components/matter/timeline-step";
import { getDocumentTypeLabel } from "../lib/document-types";
import { MattersMap } from "../components/matters-map";
import { matterStatusVariant } from "../lib/matter-status";
import { getPropertiesForMatter, propertyPath, propertyPin } from "../services/properties";
import { bylawPath, documentPath, matterPath, meetingPath } from "../lib/paths";
import { resolveSlugParam } from "../lib/slug-params.server";
import { loaderFailure } from "../lib/loader-errors";


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

const IMAGE_CAPTION: Record<string, string> = {
  rendering: "What's proposed",
  site_photo: "The site today",
  location: "Where it is",
  site_plan: "Proposed layout",
};

function mentionLabel(title: string | null | undefined) {
  const t = (title || "").toLowerCase();
  if (t.includes("notice of motion")) return "Notice of motion";
  if (t.includes("public participation") || t.includes("public input") || t.includes("question period")) return "Public comment";
  if (t.includes("presentation")) return "Presentation";
  if (t.includes("delegation")) return "Delegation";
  if (t.includes("correspondence") || t.includes("petition")) return "Correspondence";
  return "Also discussed";
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
  return relevant.length > 280 ? `${relevant.slice(0, 277).trim()}...` : relevant;
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
    const resolved = await resolveSlugParam(supabase, "matters", params.id, request, (m) => matterPath(m), "Matter Not Found", { redirectLegacy: false });
    const matter = await getMatterById(supabase, String(resolved.id));
    // Legacy ids/slugs and alias matters go straight to the canonical slug URL.
    if (matter.slug && params.id !== matter.slug) return redirect(matterPath(matter) + new URL(request.url).search, 301);

    // Fetch documents for all agenda items in this matter (batch query)
    const agendaItemIds = (matter.agenda_items || []).map((ai) => ai.id);
    const matterDocuments = await getDocumentsForAgendaItems(supabase, agendaItemIds);
    const [matterEvidence, story, properties] = await Promise.all([
      getMatterEvidence(supabase, matter.id, matter.meta?.merged_matter_ids || []),
      getMatterStory(supabase, matter.id),
      getPropertiesForMatter(supabase, matter.id),
    ]);

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

    return { matter, matterDocuments, matterEvidence, story, images, properties };
  } catch (error) {
    throw loaderFailure(error, "Matter Not Found");
  }
}

export default function MatterDetail({ loaderData }: Route.ComponentProps) {
  const { matter, matterDocuments, matterEvidence, story, images, properties = [] } = loaderData;

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

  const timelineEntries = [
    ...timeline.map((item) => ({
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
      .filter((item: any) => !primaryAgendaItemIds.has(item.id) && !story.mentions.some((direct: any) => direct.id === item.id))
      .map((item: any) => ({ kind: "mention" as const, key: `background-${item.id}`, date: item.meetings?.meeting_date, item, relatedMatter: item.relatedMatter })),
  ].sort(
    (a, b) => new Date(b.date || "").getTime() - new Date(a.date || "").getTime(),
  );

  // People who both spoke and wrote in about this matter get a note on each side.
  const aboutMatter = `${matterTitle(matter)} ${matter.plain_english_summary || ""}`;
  const notes = crossNotes(
    timelineEntries.flatMap((entry: any) =>
      entry.kind === "mention"
        ? speakersAbout(entry.item.meta?.participation, aboutMatter)
        : entry.item.meta?.participation?.speakers || [],
    ),
    timelineEntries.flatMap((entry: any) => writtenLetters(entry.item.meta?.written_participation)),
  );

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

  const statusVariant = matterStatusVariant(matter.status);

  const shortDate = (d: string | null | undefined) =>
    d
      ? formatDate(d, { year: "numeric", month: "short", day: "numeric" })
      : "";

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-4xl px-4 py-12">
        <header className="mb-10">
          <DetailHeader
            className="mb-0"
            back={{ to: "/matters", label: "Matters" }}
            meta={[
              matter.category || "General",
              matter.identifier ? (
                <span className="font-mono">{matter.identifier}</span>
              ) : null,
              firstSeen ? (
                <span className="tabular-nums">This matter recorded from {shortDate(firstSeen)}</span>
              ) : null,
              lastSeen && lastSeen !== firstSeen ? (
                <span className="tabular-nums">Last discussed {shortDate(lastSeen)}</span>
              ) : null,
            ]}
            title={matterTitle(matter)}
            badges={
              statusVariant ? (
                <Badge variant={statusVariant}>{matter.status}</Badge>
              ) : undefined
            }
            actions={
              <SubscribeButton
                type="matter"
                targetId={matter.id}
                label="Follow matter"
              />
            }
          />

          {(matter.plain_english_summary || matter.description) && (
            <p className="mt-5 max-w-2xl text-base leading-relaxed text-zinc-700">
              {matter.plain_english_summary || matter.description}
            </p>
          )}

          {matter.meta?.status_line && (
            <p className="mt-4 max-w-2xl border-l-2 border-brand-500 pl-3 text-sm leading-relaxed text-zinc-600">
              <span className="font-semibold text-zinc-900">Where it stands: </span>
              {matter.meta.status_line}
            </p>
          )}

          {images.lead && (
            <figure className="mt-6">
              <a href={images.lead.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-2xl border border-zinc-200 bg-white">
                <img
                  src={images.lead.url}
                  alt={`${IMAGE_CAPTION[images.lead.kind] || "From the staff report"}: ${matterTitle(matter)}`}
                  width={images.lead.width}
                  height={images.lead.height}
                  className="max-h-[420px] w-full object-cover"
                  loading="eager"
                />
              </a>
              <figcaption className="mt-2 text-xs text-zinc-500">
                {IMAGE_CAPTION[images.lead.kind] || "From the staff report"} · from the staff report
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
          )}

          {matter.bylaw && (
            <div className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
              <p className="mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-zinc-500">
                {[
                  "Governing bylaw",
                  matter.bylaw.bylaw_number ? `No. ${matter.bylaw.bylaw_number}` : null,
                  bylawStatus(matter.bylaw.status)?.label ?? null,
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
                to={bylawPath(matter.bylaw)}
                className="block text-base font-semibold leading-snug text-zinc-900 hover:text-brand-700"
              >
                {displayTitle(matter.bylaw.title)}
              </Link>
              {bylawLead(matter.bylaw.plain_english_summary) && (
                <p className="mt-1.5 text-sm leading-relaxed text-zinc-600">
                  {bylawLead(matter.bylaw.plain_english_summary)}
                </p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm font-semibold">
                <Link to={bylawPath(matter.bylaw)} className="text-brand-700 hover:text-brand-800">
                  Key rules and full text
                </Link>
                <a
                  href={matter.bylaw.source_url || `/api/bylaws/${matter.bylaw.id}/download`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-zinc-600 hover:text-brand-700"
                >
                  Official PDF
                </a>
              </div>
            </div>
          )}
        </header>

        <div className="space-y-12">
          {((matter.locations && matter.locations.length > 0) || properties.length > 0) && (
            <section>
              <SectionHeading title="Location" icon={MapPin} />
              {matter.locations && matter.locations.length > 0 && (
                <div className="overflow-hidden rounded-2xl border border-zinc-200 shadow-sm">
                  <MattersMap matters={[matter]} activeLocation={matter.locations?.[0]} />
                </div>
              )}
              {properties.length > 0 && (
                <ul className={cn("space-y-3", matter.locations?.length ? "mt-4" : "")}>
                  {properties.map((p) => (
                    <li key={p.id} className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <Link to={propertyPath(p)} className="font-semibold text-zinc-900 hover:text-brand-700">
                          {p.address}
                        </Link>
                        <span className="text-sm text-zinc-500">
                          {p.others.length === 0
                            ? "No other matters at this address"
                            : `${p.others.length} other ${p.others.length === 1 ? "matter" : "matters"} at this address`}
                        </span>
                      </div>
                      {p.others.length > 0 && (
                        <ul className="mt-2 space-y-1.5">
                          {p.others.slice(0, 4).map((m: any) => (
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
                      {p.others.length > 4 && (
                        <Link to={propertyPath(p)} className="mt-2 inline-block text-sm font-medium text-brand-700 hover:underline">
                          See all {p.others.length + 1} at {p.address}
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
                title="Background"
                description="Earlier and later steps of the same initiative."
              />
              <ol className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm divide-y divide-zinc-100">
                {story.related.map((r: any) => (
                  <li key={r.id}>
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
              description="Every time this matter appeared in council records, newest first."
            />

            {timelineEntries.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-zinc-200 bg-white px-6 py-12 text-center text-sm text-zinc-500">
                No meeting records are linked to this matter yet.
              </div>
            ) : (
              <ol className="relative space-y-4 before:absolute before:bottom-4 before:left-[5px] before:top-4 before:w-px before:bg-zinc-200">
                {timelineEntries.map((entry: any) => {
                  if (entry.kind === "mention") {
                    const item = entry.item;
                    return (
                      <li key={entry.key} className="relative pl-7">
                        <span className="absolute left-0 top-5 h-[11px] w-[11px] rounded-full border-2 border-zinc-50 bg-zinc-300" />
                        <div className="rounded-2xl border border-dashed border-zinc-200 bg-white/70 px-5 py-4">
                          <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-zinc-500">
                            <Link to={meetingPath({ id: item.meeting_id, slug: item.meetings?.slug })} className="tabular-nums hover:text-brand-700">
                              {formatDate(item.meetings?.meeting_date)}
                            </Link>
                            <span className="text-zinc-300">·</span>
                            {entry.relatedMatter ? (
                              <Link to={matterPath(entry.relatedMatter)} className="hover:text-brand-700">Background · {matterTitle(entry.relatedMatter)}</Link>
                            ) : <span>{mentionLabel(item.title)}</span>}
                          </div>
                          {entry.relatedMatter && <p className="mb-1 text-sm font-medium text-zinc-700">{displayTitle(item.title)}</p>}
                          {(() => {
                            const about = speakersAbout(item.meta?.participation, `${matterTitle(matter)} ${matter.plain_english_summary || ""}`);
                            return about.length > 0 ? (
                              <ParticipationList speakers={about} note={notes.speaker} className="mt-1" />
                            ) : (
                              item.plain_english_summary && (
                                <p className="text-sm leading-relaxed text-zinc-600">{item.plain_english_summary}</p>
                              )
                            );
                          })()}
                        </div>
                      </li>
                    );
                  }
                  if (entry.kind === "evidence") {
                    return (
                      <li key={entry.key} className="relative pl-7">
                        <span className="absolute left-0 top-6 h-[11px] w-[11px] rounded-full border-2 border-zinc-50 bg-zinc-300" />
                        <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
                          <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-zinc-500">
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
                              <span className="text-xs tabular-nums">
                                {entry.matchCount} references
                              </span>
                            )}
                          </div>
                          <h3 className="text-base font-semibold leading-snug text-zinc-900">
                            {displayTitle(entry.title)}
                          </h3>
                          {entry.snippet && (
                            <p className="mt-1.5 line-clamp-3 text-sm leading-relaxed text-zinc-600">
                              {entry.snippet}
                            </p>
                          )}
                        </div>
                      </li>
                    );
                  }

                  const item = entry.item;
                  const itemDocs = docsByItem.get(item.id) || [];
                  // Pipeline-written plain-English headline; the agenda wording lives in Details.
                  const headline: string | undefined = matter.meta?.timeline_headlines?.[String(item.id)];
                  const layout = images.layout && images.layout.agenda_item_id === item.id ? images.layout : null;
                  const procedural = isProceduralStep(item, {
                    hasParticipation: Boolean(
                      (item as any).meta?.participation?.speakers?.length ||
                        writtenLetters((item as any).meta?.written_participation).length,
                    ),
                    hasImage: Boolean(layout),
                    headline,
                  });
                  return (
                    <li key={entry.key} className="relative pl-7">
                      <span
                        className={cn(
                          "absolute left-0 h-[11px] w-[11px] rounded-full border-2 border-zinc-50",
                          procedural ? "top-1.5 bg-zinc-300" : "top-6 bg-brand-600",
                        )}
                      />
                      <TimelineStep
                        item={item}
                        headline={headline}
                        docs={itemDocs}
                        layoutImage={layout}
                        participation={(item as any).meta?.participation}
                        written={(item as any).meta?.written_participation}
                        notes={notes}
                      />
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
