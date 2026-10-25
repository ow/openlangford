import { ParticipationList, WrittenSubmissions } from "./participation-list";
import { crossNotes, writtenLetters } from "../../lib/written";
import { documentPath } from "../../lib/paths";
import { useState } from "react";
import { Link } from "react-router";
import {
  ChevronRight,
  Clock,
  DollarSign,
  FileText,
  Gavel,
  Info,
  MapPin,
  MessageSquare,
  PlayCircle,
  Tag,
  ThumbsDown,
  ThumbsUp,
  Minus,
  CheckCircle2,
  XCircle,
  MinusCircle,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { displayTitle } from "../../lib/display-text";
import { cn } from "../../lib/utils";
import type { AgendaItem, Motion, Vote, DocumentSection, ExtractedDocument } from "../../lib/types";
import { Badge } from "../ui/badge";
import { MotionOutcomeBadge } from "../motion-outcome-badge";
import { normalizeMotionResult } from "../../lib/motion-utils";
import { formatTimestamp } from "../../lib/timeline-utils";
import { DocumentSections } from "./DocumentSections";

interface AgendaOverviewProps {
  items: AgendaItem[];
  /** Agenda item id -> property pages for the addresses it names. */
  itemProperties?: Record<number, { slug: string; address: string }[]>;
  documentSections?: DocumentSection[];
  extractedDocuments?: ExtractedDocument[];
  expandedItemId: number | null;
  onItemClick: (id: number) => void;
  onWatchVideo: (startTime: number, itemId: number) => void;
  onMotionClick?: (motion: Motion, agendaItem: AgendaItem) => void;
  meetingId: number;
  meetingSlug?: string | null;
}

export function AgendaOverview({
  items,
  documentSections,
  extractedDocuments,
  expandedItemId,
  onItemClick,
  onWatchVideo,
  onMotionClick,
  meetingId,
  meetingSlug,
  itemProperties,
}: AgendaOverviewProps) {
  const groups = groupAgendaItems(items);
  // People who both spoke and wrote in at this meeting get a note on each side.
  const notes = crossNotes(
    items.flatMap((it: any) => it.meta?.participation?.speakers || []),
    items.flatMap((it: any) => writtenLetters(it.meta?.written_participation)),
  );

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-zinc-200 overflow-hidden">

      <div className="divide-y divide-zinc-100">
        {items.length === 0 ? (
          <div className="p-8 text-center text-zinc-500 italic">
            No agenda items available for this meeting.
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.key} className="relative py-1">
              {/* If we have a main parent item, render it first */}
              {group.parent ? (
                <AgendaItemRow
                  item={group.parent}
                  documentSections={documentSections}
                  extractedDocuments={extractedDocuments}
                  displayOrder={cleanOrder(group.parent.item_order)}
                  isExpanded={expandedItemId === group.parent.id}
                  onToggle={() => onItemClick(group.parent!.id)}
                  onWatchVideo={(startTime) =>
                    onWatchVideo(startTime, group.parent!.id)
                  }
                  onMotionClick={onMotionClick}
                  variant="parent"
                  properties={itemProperties?.[group.parent.id]}
                  hasChildren={group.children.length > 0}
                  meetingId={meetingId}
                  meetingSlug={meetingSlug}
                  notes={notes}
                />
              ) : group.key !== "other" && group.children.length > 0 ? (
                /* Virtual Parent Header for orphaned items */
                <div className="flex items-center px-4 pt-3 pb-1 gap-3">
                  <div className="w-8 text-right text-sm font-semibold tabular-nums text-zinc-400 select-none">
                    {group.key}
                  </div>
                  <div className="text-zinc-500 font-medium text-sm">
                    Section {group.key}
                  </div>
                </div>
              ) : null}

              {/* Render children */}
              <div className="flex flex-col">
                {group.children.map((child, idx) => {
                  const isLast = idx === group.children.length - 1;
                  // Simplify child order: remove parent prefix if present
                  let displayOrder = cleanOrder(child.item_order);
                  const parentPrefix = group.key;

                  if (
                    group.key !== "other" &&
                    displayOrder.startsWith(parentPrefix)
                  ) {
                    const suffix = displayOrder.slice(parentPrefix.length);
                    // Only simplify if the suffix looks like a child separator (dot, space, paren)
                    if (/^[.\-)\s]/.test(suffix)) {
                      displayOrder = suffix.replace(/^[.\-)\s]+/, "");
                    }
                  }

                  return (
                    <AgendaItemRow
                      key={child.id}
                      item={child}
                      documentSections={documentSections}
                      extractedDocuments={extractedDocuments}
                      displayOrder={displayOrder}
                      isExpanded={expandedItemId === child.id}
                      onToggle={() => onItemClick(child.id)}
                      onWatchVideo={(startTime) =>
                        onWatchVideo(startTime, child.id)
                      }
                      onMotionClick={onMotionClick}
                      variant={group.key !== "other" ? "child" : "flat"}
                      properties={itemProperties?.[child.id]}
                      isLastChild={isLast}
                      meetingId={meetingId}
                      meetingSlug={meetingSlug}
                      notes={notes}
                    />
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// --- Grouping Logic ---

interface AgendaGroup {
  key: string;
  parent?: AgendaItem;
  children: AgendaItem[];
  numericKey: number;
}

function groupAgendaItems(items: AgendaItem[]): AgendaGroup[] {
  const groups: Record<string, AgendaGroup> = {};
  const sortedItems = [...items].sort(naturalSortItems);

  for (const item of sortedItems) {
    const order = cleanOrder(item.item_order);
    // Extract the primary section number (e.g., "3" from "3.a", "6" from "6.1")
    // Fallback to the full order if it doesn't start with a number.
    // Also capture letter-based sections like "q)".
    const match = order.match(/^(\d+|[a-z]\))/i);
    const key = match ? match[1] : "other";

    let numericKey = 9999;
    if (match) {
      const num = parseInt(match[1], 10);
      if (!isNaN(num)) {
        numericKey = num;
      } else {
        // For letter-based sections, put them after numeric sections
        numericKey = match[1].charCodeAt(0) + 1000;
      }
    }

    if (!groups[key]) {
      groups[key] = { key, children: [], numericKey };
    }

    // Check if this item IS the section header (e.g. order is exactly "3")
    // We treat it as parent if it matches the key exactly, OR if it's the first item and looks like a parent
    if (order === key) {
      if (groups[key].parent) {
        // Duplicate parent number? Treat as child or fallback
        groups[key].children.push(item);
      } else {
        groups[key].parent = item;
      }
    } else {
      groups[key].children.push(item);
    }
  }

  // Convert map to sorted array
  return Object.values(groups).sort((a, b) => {
    if (a.key === "other") return 1;
    if (b.key === "other") return -1;
    return a.numericKey - b.numericKey;
  });
}

function cleanOrder(order?: string): string {
  if (!order) return "";
  // Remove leading/trailing parens, dots, and whitespace
  return order.trim().replace(/^[\s(.)]+|[\s(.)]+$/g, "");
}

function naturalSortItems(a: AgendaItem, b: AgendaItem) {
  const orderA = cleanOrder(a.item_order);
  const orderB = cleanOrder(b.item_order);
  return orderA.localeCompare(orderB, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function formatDiscussionDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

/** Whether a raw address mentions the street of a linked property ("2207 Millstream Rd" ~ "2207 Millstream Road"). */
function sameStreet(raw: string, address: string) {
  const name = address.replace(/^\d+\w?\s+/, "").split(/\s+/).slice(0, -1).join(" ").toLowerCase();
  return Boolean(name) && raw.toLowerCase().replace(/-/g, " ").includes(name.replace(/-/g, " "));
}

function normalizeRelatedAddresses(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter(
      (addr): addr is string =>
        typeof addr === "string" && addr.trim().length > 0,
    );
  }

  if (typeof value !== "string") return [];

  const trimmed = value.trim();
  if (!trimmed || trimmed === "[]") return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (addr): addr is string =>
          typeof addr === "string" && addr.trim().length > 0,
      );
    }
  } catch {
    // Some historical rows store a single address as plain text.
  }

  return [trimmed];
}

// --- Components ---

interface AgendaItemRowProps {
  notes?: ReturnType<typeof crossNotes>;
  properties?: { slug: string; address: string }[];
  item: AgendaItem;
  documentSections?: DocumentSection[];
  extractedDocuments?: ExtractedDocument[];
  displayOrder: string;
  isExpanded: boolean;
  onToggle: () => void;
  onWatchVideo: (startTime: number) => void;
  onMotionClick?: (motion: Motion, agendaItem: AgendaItem) => void;
  variant: "parent" | "child" | "flat";
  hasChildren?: boolean;
  isLastChild?: boolean;
  meetingId: number;
  meetingSlug?: string | null;
}

function AgendaItemRow({
  item,
  documentSections,
  extractedDocuments,
  displayOrder,
  isExpanded,
  onToggle,
  onWatchVideo,
  onMotionClick,
  variant,
  hasChildren,
  isLastChild,
  meetingId,
  meetingSlug,
  notes,
  properties = [],
}: AgendaItemRowProps) {
  const linkedSections = (documentSections || []).filter(
    (s) => s.agenda_item_id === item.id,
  );
  const linkedExtractedDocs = (extractedDocuments || []).filter(
    (ed) => ed.agenda_item_id === item.id,
  );
  const motions = item.motions || [];
  const hasMotions = motions.length > 0;
  const motionCount = motions.length;
  const discussionDuration =
    item.discussion_start_time != null && item.discussion_end_time != null
      ? item.discussion_end_time - item.discussion_start_time
      : 0;
  const relatedAddresses = normalizeRelatedAddresses(item.related_address);

  const hasBadges =
    item.is_consent_agenda || item.category || item.is_controversial;
  const hasMetadata =
    (item.financial_cost !== undefined && item.financial_cost > 0) ||
    discussionDuration > 0 ||
    motionCount > 0 ||
    linkedExtractedDocs.length > 0 ||
    (item.keywords && item.keywords.length > 0);

  const isParent = variant === "parent";
  const isChild = variant === "child";
  // Procedural housekeeping ("Call to order", "Adjournment") recedes so
  // the substantive business stands out.
  const isProcedural = item.category === "Procedural" && !item.is_controversial;
  const preview = item.plain_english_summary || null;

  return (
    <div className="relative scroll-mt-24" id={`item-${item.id}`}>

      {/* Row Button */}
      <button
        onClick={onToggle}
        aria-expanded={isExpanded}
        className={cn(
          "w-full flex items-start gap-3 text-left transition-colors relative z-0 pr-4",
          isExpanded ? "bg-zinc-50" : "hover:bg-zinc-50/70",
          isProcedural ? "py-2" : "py-3",
          isChild ? "pl-10" : "pl-4",
        )}
      >
        {/* Number */}
        <div
          className={cn(
            "w-8 shrink-0 select-none break-words pt-px text-right text-sm font-semibold tabular-nums",
            isProcedural ? "text-zinc-300" : "text-zinc-400",
          )}
        >
          {displayOrder === "official-recorded-motions" ? "•" : displayOrder || "•"}
        </div>

        {/* Main Content */}
        <div className="min-w-0 flex-1">
          <h3
            className={cn(
              "leading-snug",
              isProcedural
                ? "text-sm text-zinc-500"
                : isParent && hasChildren
                  ? "text-[15px] font-semibold text-zinc-900"
                  : "text-[15px] font-medium text-zinc-900",
            )}
          >
            {displayTitle(item.title)}
            {item.is_consent_agenda && (
              <span className="ml-2 align-middle text-xs font-medium text-brand-700">Consent</span>
            )}
          </h3>

          {!isProcedural && !isExpanded && preview && (
            <p className="mt-0.5 text-sm leading-relaxed text-zinc-500 line-clamp-1">
              {preview}
            </p>
          )}

          {!isProcedural && hasMetadata && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
              {item.financial_cost !== undefined && item.financial_cost > 0 && (
                <span className="inline-flex items-center font-medium text-zinc-700">
                  <DollarSign className="w-3 h-3" />
                  {new Intl.NumberFormat("en-CA", {
                    maximumFractionDigits: 0,
                  }).format(item.financial_cost)}
                </span>
              )}
              {discussionDuration > 60 && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {formatDiscussionDuration(discussionDuration)}
                </span>
              )}
              {linkedExtractedDocs.length > 0 && (
                <span className="inline-flex items-center gap-1">
                  <FileText className="w-3 h-3" />
                  {linkedExtractedDocs.length} {linkedExtractedDocs.length === 1 ? "document" : "documents"}
                </span>
              )}
              {writtenLetters(item.meta?.written_participation).length > 0 && (
                <span className="tabular-nums">
                  {writtenLetters(item.meta?.written_participation).length}{" "}
                  {writtenLetters(item.meta?.written_participation).length === 1 ? "letter" : "letters"}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Right Side: Outcome + Chevron */}
        <div className="flex items-center gap-2 flex-shrink-0 pt-px pl-2">
          {!isProcedural && <MotionResultBadge motions={motions} />}
          <ChevronRight
            className={cn(
              "h-4 w-4 text-zinc-300 transition-transform flex-shrink-0",
              isExpanded && "rotate-90 text-zinc-500",
            )}
          />
        </div>
      </button>

      {/* Expanded Content */}
      <div
        className={cn(
          "grid transition-all duration-200 ease-in-out relative z-10",
          isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">

          <div
            className={cn(
              "pr-4 pb-5 pt-1",
              isChild ? "pl-[5.25rem]" : "pl-[3.75rem]",
            )}
          >
            <div className="space-y-6">
              {/* Plain English Summary */}
              {item.plain_english_summary && (
                <div className="space-y-1">
                  <h4 className="flex items-center gap-2 text-xs font-semibold text-zinc-500">
                    <Info className="w-3 h-3 text-brand-500" />
                    Summary
                  </h4>
                  <p className="text-sm text-zinc-800 leading-relaxed pl-5">
                    {item.plain_english_summary}
                  </p>
                </div>
              )}

              {/* Public comment, one line per speaker */}
              {item.meta?.participation?.speakers?.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-zinc-500">
                    Who spoke ({item.meta.participation.speakers.length})
                  </h4>
                  <ParticipationList participation={item.meta.participation} note={notes?.speaker} className="pl-0.5" />
                  <p className="text-xs text-zinc-400">
                    {item.meta.participation.source === "minutes"
                      ? "Summarized from the meeting minutes. Speakers are listed as the minutes identify them."
                      : "Summarized from the meeting video. Names are shown when speakers introduce themselves, spelled as in the minutes where listed; others appear as “A resident”."}
                  </p>
                </div>
              )}

              {/* Letters and emails sent in before the meeting */}
              {writtenLetters(item.meta?.written_participation).length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-zinc-500">
                    Written submissions ({writtenLetters(item.meta?.written_participation).length})
                  </h4>
                  <WrittenSubmissions
                    written={item.meta?.written_participation}
                    documentHref={(documentId) => documentPath({ id: meetingId, slug: meetingSlug }, documentId)}
                    note={notes?.letter}
                    className="pl-0.5"
                  />
                </div>
              )}

              {/* Description fallback */}
              {!item.plain_english_summary && item.description && (
                <div className="space-y-1">
                  <h4 className="text-xs font-semibold text-zinc-500">
                    Description
                  </h4>
                  <p className="text-sm text-zinc-600 leading-relaxed whitespace-pre-line pl-0.5">
                    {item.description}
                  </p>
                </div>
              )}

              {/* Financial impact */}
              {item.financial_cost !== undefined && item.financial_cost > 0 && (
                <div className="space-y-1">
                  <h4 className="flex items-center gap-2 text-xs font-semibold text-zinc-500">
                    <DollarSign className="w-3 h-3 text-emerald-600" />
                    Financial impact
                  </h4>
                  <p className="text-sm text-zinc-800 font-semibold pl-5">
                    {new Intl.NumberFormat("en-CA", {
                      style: "currency",
                      currency: "CAD",
                      maximumFractionDigits: 0,
                    }).format(item.financial_cost)}
                    {item.funding_source && (
                      <span className="font-normal text-zinc-500 ml-1">
                        &mdash; {item.funding_source}
                      </span>
                    )}
                  </p>
                </div>
              )}

              {/* Location / Addresses */}
              {(relatedAddresses.length > 0 || properties.length > 0) && (
                <div className="space-y-1">
                  <h4 className="flex items-center gap-2 text-xs font-semibold text-zinc-500">
                    <MapPin className="w-3 h-3 text-violet-600" />
                    Location
                  </h4>
                  <div className="text-sm text-zinc-800 space-y-0.5 pl-5">
                    {/* Addresses with a property page link to everything else at that lot or street. */}
                    {properties.map((p) => (
                      <p key={p.slug}>
                        <Link to={`/properties/${p.slug}`} className="text-brand-700 hover:underline">
                          {p.address}
                        </Link>
                      </p>
                    ))}
                    {relatedAddresses
                      .filter((addr) => !properties.some((p) => sameStreet(addr, p.address)))
                      .map((addr, i) => (
                        <p key={i} className="text-zinc-700">
                          {addr}
                        </p>
                      ))}
                  </div>
                </div>
              )}

              {/* Debate */}
              {item.debate_summary && (
                <div className="space-y-1">
                  <h4 className="flex items-center gap-2 text-xs font-semibold text-zinc-500">
                    <MessageSquare className="w-3 h-3 text-amber-500" />
                    Debate
                  </h4>
                  <p className="text-sm text-zinc-800 leading-relaxed whitespace-pre-line pl-5">
                    {item.debate_summary}
                  </p>
                </div>
              )}

              {/* Watch discussion Button */}
              {item.discussion_start_time != null && (
                <div className="pl-5">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onWatchVideo(item.discussion_start_time!);
                    }}
                    className="inline-flex items-center gap-2 text-sm font-semibold text-brand-600 hover:text-brand-700 bg-brand-50 hover:bg-brand-100 px-3 py-1.5 rounded-lg transition-colors"
                  >
                    Watch discussion
                    <span className="text-xs text-brand-400 font-mono">
                      {formatTimestamp(item.discussion_start_time)}
                      {discussionDuration > 0 &&
                        ` (${formatDiscussionDuration(discussionDuration)})`}
                    </span>
                  </button>
                </div>
              )}

              {/* Motions */}
              {hasMotions && (
                <div className="space-y-2">
                  <h4 className="flex items-center gap-2 text-xs font-semibold text-zinc-500">
                    <Gavel className="w-3 h-3 text-zinc-500" />
                    Motions ({motionCount})
                  </h4>
                  <div className="pl-5 space-y-2">
                    {motions.map((motion) => (
                      <MotionCardInline
                        key={motion.id}
                        motion={motion}
                        agendaItem={item}
                        onWatchVideo={() => {
                          const time =
                            motion.time_offset_seconds ??
                            item.discussion_start_time;
                          if (time != null) {
                            onWatchVideo(time);
                          }
                        }}
                        onClick={
                          onMotionClick
                            ? () => onMotionClick(motion, item)
                            : undefined
                        }
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Document Sections */}
              {linkedSections.length > 0 && (
                <DocumentSections
                  sections={linkedSections}
                  extractedDocuments={linkedExtractedDocs}
                  meetingId={meetingId}
                  meetingSlug={meetingSlug}
                />
              )}

              {/* Keywords */}
              {item.keywords && item.keywords.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pl-5">
                  {item.keywords.map((kw) => (
                    <span
                      key={kw}
                      className="text-[10px] font-medium text-zinc-600 bg-zinc-100 px-2 py-0.5 rounded-full border border-zinc-200"
                    >
                      {kw}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Helpers ---

function MotionResultBadge({ motions }: { motions: Motion[] }) {
  if (!motions || motions.length === 0) return null;
  const outcomes = motions.map((m) => normalizeMotionResult(m.result));
  if (outcomes.some((o) => o === "failed")) {
    return <Badge variant="danger">Defeated</Badge>;
  }
  if (outcomes.every((o) => o === "passed")) {
    return <Badge variant="success">Carried</Badge>;
  }
  return null;
}

interface MotionCardInlineProps {
  motion: Motion;
  agendaItem: AgendaItem;
  onWatchVideo: () => void;
  onClick?: () => void;
}

function MotionCardInline({
  motion,
  agendaItem,
  onWatchVideo,
  onClick,
}: MotionCardInlineProps) {
  const [showVotes, setShowVotes] = useState(false);
  const votes = motion.votes || [];

  return (
    <div
      onClick={onClick}
      className={cn(
        "group relative p-3 rounded-xl border border-zinc-200 bg-white hover:border-brand-300 transition-all",
        onClick && "cursor-pointer hover:shadow-sm",
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2 flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <MotionOutcomeBadge result={motion.result} className="h-5 text-[10px] px-1.5" />
            <span className="text-[10px] font-mono text-zinc-400 truncate">
              {motion.mover ? `Moved by ${motion.mover}` : "Mover not recorded"}
            </span>
            {votes.length > 0 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowVotes(!showVotes);
                }}
                className="ml-auto text-[10px] font-medium text-zinc-500 hover:text-brand-600 flex items-center gap-1 bg-zinc-50 px-2 py-0.5 rounded-full border border-zinc-100 hover:border-brand-200 transition-colors"
              >
                {votes.length} Votes
                {showVotes ? (
                  <ChevronUp className="w-3 h-3" />
                ) : (
                  <ChevronDown className="w-3 h-3" />
                )}
              </button>
            )}
          </div>

          <p className="text-sm text-zinc-800 font-medium leading-relaxed line-clamp-2 group-hover:line-clamp-none transition-all">
            {motion.text_content}
          </p>

          {showVotes && votes.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 pt-2 animate-in fade-in slide-in-from-top-1 duration-200">
              {votes.map((vote: Vote) => (
                <div
                  key={vote.id}
                  className="flex items-center gap-1.5 p-1.5 rounded bg-zinc-50 border border-zinc-100 text-xs"
                >
                  {vote.vote === "Yes" ? (
                    <CheckCircle2 className="h-3 w-3 text-emerald-500 flex-shrink-0" />
                  ) : vote.vote === "No" ? (
                    <XCircle className="h-3 w-3 text-red-500 flex-shrink-0" />
                  ) : (
                    <MinusCircle className="h-3 w-3 text-zinc-400 flex-shrink-0" />
                  )}
                  <span
                    className="truncate text-zinc-600"
                    title={vote.person?.name}
                  >
                    {vote.person?.name || "Unknown"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={(e) => {
            e.stopPropagation();
            onWatchVideo();
          }}
          className="flex-shrink-0 text-zinc-400 hover:text-brand-600 transition-colors p-1"
          title="Watch discussion for this motion"
        >
          <PlayCircle className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}
