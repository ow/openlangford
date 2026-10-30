import { Link } from "react-router";
import { documentPath, matterPath, meetingPath } from "../../lib/paths";
import { Gavel, MessageSquare, FileText, Mic, Tag } from "lucide-react";
import { Badge } from "../ui/badge";
import { formatDate } from "../../lib/utils";
import type { UnifiedSearchResult } from "../../services/hybrid-search.server";
import { MotionOutcomeBadge } from "../motion-outcome-badge";
import { trackEvent } from "../../lib/analytics";
import { SpeakerName } from "../ui/speaker-name";

// ---------------------------------------------------------------------------
// Query highlighting
// ---------------------------------------------------------------------------

function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query || !text) return <>{text}</>;
  try {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const parts = text.split(new RegExp(`(${escaped})`, "gi"));
    return (
      <>
        {parts.map((part, i) =>
          part.toLowerCase() === query.toLowerCase() ? (
            <mark
              key={i}
              className="bg-amber-100 text-zinc-900 rounded-sm px-0.5"
            >
              {part}
            </mark>
          ) : (
            <span key={i}>{part}</span>
          ),
        )}
      </>
    );
  } catch {
    return <>{text}</>;
  }
}

// ---------------------------------------------------------------------------
// Type-specific card configurations
// ---------------------------------------------------------------------------

const TYPE_CONFIG = {
  matter: { Icon: Tag, label: "Matter" },
  motion: { Icon: Gavel, label: "Motion" },
  key_statement: { Icon: MessageSquare, label: "Statement" },
  document_section: { Icon: FileText, label: "Document" },
  transcript_segment: { Icon: Mic, label: "Transcript" },
} as const;

// ---------------------------------------------------------------------------
// Type-specific URL resolution
// ---------------------------------------------------------------------------

function getResultUrl(result: UnifiedSearchResult): string {
  if (result.type === "matter") {
    return matterPath({ id: result.matter_id || result.id, slug: result.matter_slug });
  }

  if (!result.meeting_id) return "#";
  const meeting = { id: result.meeting_id, slug: result.meeting_slug };

  switch (result.type) {
    case "motion":
    case "key_statement":
      // Link to meeting page anchored at the parent agenda item
      return result.agenda_item_id
        ? meetingPath(meeting, `#agenda-${result.agenda_item_id}`)
        : meetingPath(meeting);

    case "document_section":
      // Link to document viewer (uses extracted_document_id, not document_id)
      if (result.extracted_document_id)
        return documentPath(meeting, result.extracted_document_id);
      if (result.agenda_item_id)
        return meetingPath(meeting, `#agenda-${result.agenda_item_id}`);
      return meetingPath(meeting);

    case "transcript_segment":
      // The segment ID remains precise even when nearby timestamps overlap.
      return meetingPath(meeting, `#transcript=${result.id}`);

    default:
      return meetingPath(meeting);
  }
}

// ---------------------------------------------------------------------------
// ResultCard component
// ---------------------------------------------------------------------------

interface ResultCardProps {
  result: UnifiedSearchResult;
  query: string;
  position?: number;
}

export function ResultCard({ result, query, position }: ResultCardProps) {
  const { Icon, label } = TYPE_CONFIG[result.type];
  const linkTo = getResultUrl(result);

  // Matter "content" is just "Category — Status"; show it as meta instead
  const isMatter = result.type === "matter";
  const [matterCategory] = isMatter ? (result.content || "").split(" — ") : [];
  const showTitle =
    isMatter || (result.type === "document_section" && result.title !== "Document Section");
  const showStatus = isMatter && result.matter_status && result.matter_status !== "Active";

  return (
    <Link
      to={linkTo}
      onClick={() =>
        trackEvent("search result clicked", {
          result_type: result.type,
          result_position: position,
          meeting_id: result.meeting_id,
          destination: linkTo,
        })
      }
      className="group flex gap-3 px-5 py-4 transition-colors hover:bg-zinc-50"
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400 group-hover:text-brand-600" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-zinc-500">
          <span className="font-medium text-zinc-700">{label}</span>
          {isMatter && matterCategory && (
            <>
              <span aria-hidden="true">·</span>
              <span>{matterCategory}</span>
            </>
          )}
          {result.type === "key_statement" && result.statement_type && (
            <>
              <span aria-hidden="true">·</span>
              <span>{result.statement_type}</span>
            </>
          )}
          {result.speaker_name && (
            <>
              <span aria-hidden="true">·</span>
              <SpeakerName name={result.speaker_name} className="font-medium text-zinc-700" />
            </>
          )}
          {result.meeting_date && (
            <>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">
                {formatDate(result.meeting_date, { month: "short", day: "numeric", year: "numeric" })}
              </span>
            </>
          )}
          {result.type === "motion" && result.motion_result && (
            <MotionOutcomeBadge result={result.motion_result} className="ml-1 text-[10px]" />
          )}
          {showStatus && <Badge variant="muted" className="ml-1">{result.matter_status}</Badge>}
        </div>

        {showTitle && (
          <h4 className="text-[15px] font-semibold leading-snug text-zinc-900 group-hover:text-brand-700">
            <HighlightText text={result.title} query={query} />
          </h4>
        )}

        {!isMatter && (
          <p className="text-sm leading-relaxed text-zinc-700 line-clamp-3">
            <HighlightText text={result.content} query={query} />
          </p>
        )}

        {result.type === "motion" && (result.motion_mover || result.motion_seconder) && (
          <p className="mt-1.5 text-xs text-zinc-500">
            {result.motion_mover && `Moved by ${result.motion_mover}`}
            {result.motion_mover && result.motion_seconder && ", "}
            {result.motion_seconder && `seconded by ${result.motion_seconder}`}
          </p>
        )}
      </div>
    </Link>
  );
}
