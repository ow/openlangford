import { useMemo, useState } from "react";
import type { TranscriptSegment, AgendaItem } from "../lib/types";
import { cn } from "~/lib/utils";
import { MotionOutcomeBadge } from "./motion-outcome-badge";
import { normalizeMotionResult } from "../lib/motion-utils";
import { formatTimestamp } from "../lib/timeline-utils";
import { displayTitle, lastName } from "../lib/display-text";
import { formatSpeakerName } from "../lib/speaker-labels";
import { SpeakerName } from "./ui/speaker-name";
import {
  getSpeakerColorIndex,
  SPEAKER_COLORS,
  SPEAKER_BG_LIGHT_COLORS,
} from "../lib/colors";

interface SegmentInfo {
  id: number;
  text: string;
  start: number;
  end: number;
}

interface SpeechEvent {
  type: "speech";
  start: number;
  end: number;
  speaker: string;
  segments: SegmentInfo[];
  id: string;
}

interface MotionEvent {
  type: "motion";
  start: number;
  end: number;
  text: string;
  summary?: string;
  result?: string;
  id: string;
  votes?: any[];
}

interface AgendaEvent {
  type: "agenda";
  start: number;
  end: number;
  title: string;
  item_order?: string;
  id: string;
  debate_summary?: string;
  key_quotes?: any[];
  category?: string;
}

type TimelineEvent = SpeechEvent | MotionEvent | AgendaEvent;

interface MeetingTimelineProps {
  transcript: TranscriptSegment[];
  agendaItems: AgendaItem[];
  onSegmentHover?: (segmentId: number | null) => void;
  activeSegmentId?: number | null;
  speakerMap?: Record<string, string>;
  /** Seek the page's video player. Without it the timeline is read-only. */
  onSeek?: (seconds: number) => void;
  /** Playback position of the page's video, drawn as a playhead. */
  currentTime?: number;
}

function cleanOrder(order?: string) {
  return (order || "").trim().replace(/^[\s(.)]+|[\s(.)]+$/g, "");
}

function motionDotClass(result?: string) {
  const outcome = normalizeMotionResult(result);
  if (outcome === "passed") return "bg-emerald-500";
  if (outcome === "failed") return "bg-red-500";
  if (outcome === "tabled") return "bg-amber-500";
  return "bg-zinc-400";
}

/**
 * A minute-by-minute map of the meeting: who spoke when (one bar per
 * speaking turn), where each agenda item started, and when motions were
 * voted on. Hover for details; click to jump the video there.
 */
export function MeetingTimeline({
  transcript,
  agendaItems,
  onSegmentHover,
  activeSegmentId,
  speakerMap,
  onSeek,
  currentTime,
}: MeetingTimelineProps) {
  const [hoveredEvent, setHoveredEvent] = useState<TimelineEvent | null>(null);
  const [hoveredSegment, setHoveredSegment] = useState<SegmentInfo | null>(
    null,
  );

  const events = useMemo(() => {
    const speechEvents: SpeechEvent[] = [];
    const motionEvents: MotionEvent[] = [];
    const agendaEvents: AgendaEvent[] = [];

    // Heuristic: Map agenda items and motions to transcript times if meta is missing
    const agendaPositions = new Map<number, number>();
    const motionPositions = new Map<number, number>();

    // Helper to find which agenda item a timestamp belongs to
    const findAgendaItemForTime = (time: number) => {
      return agendaItems.find(
        (item) =>
          item.discussion_start_time !== null &&
          item.discussion_start_time !== undefined &&
          item.discussion_end_time !== null &&
          item.discussion_end_time !== undefined &&
          time >= item.discussion_start_time &&
          time < item.discussion_end_time,
      );
    };

    transcript.forEach((segment) => {
      const resolvedAgendaItemId =
        segment.agenda_item_id ||
        findAgendaItemForTime(segment.start_time)?.id ||
        null;

      if (resolvedAgendaItemId && !agendaPositions.has(resolvedAgendaItemId)) {
        agendaPositions.set(resolvedAgendaItemId, segment.start_time);
      }
      if (segment.motion_id && !motionPositions.has(segment.motion_id)) {
        motionPositions.set(segment.motion_id, segment.start_time);
      }

      let speaker = segment.person?.name || segment.speaker_name;

      if (!segment.person?.name && segment.speaker_name && speakerMap) {
        const label = segment.speaker_name;
        const normalized = label.toUpperCase().replace(/\s+/g, "_");
        speaker =
          speakerMap[label] || speakerMap[normalized] || speakerMap[label.toUpperCase()] || label;
      }
      speaker = formatSpeakerName(speaker);

      const lastSpeech = speechEvents[speechEvents.length - 1];

      // Merge into a "turn" if same speaker and close in time
      if (
        lastSpeech &&
        lastSpeech.speaker === speaker &&
        segment.start_time - lastSpeech.end < 10
      ) {
        lastSpeech.end = segment.end_time;
        lastSpeech.segments.push({
          id: segment.id,
          text: segment.text_content,
          start: segment.start_time,
          end: segment.end_time,
        });
      } else {
        speechEvents.push({
          type: "speech",
          start: segment.start_time,
          end: segment.end_time,
          speaker: speaker,
          segments: [
            {
              id: segment.id,
              text: segment.text_content,
              start: segment.start_time,
              end: segment.end_time,
            },
          ],
          id: `speech-turn-${segment.id}`,
        });
      }
    });

    agendaItems.forEach((item) => {
      // Use discussion_start_time, then transcript-based position, then 0
      const agendaStartTime =
        item.discussion_start_time ?? agendaPositions.get(item.id);
      const agendaEndTime =
        item.discussion_end_time ??
        (agendaStartTime ? agendaStartTime + 10 : undefined);

      if (agendaStartTime !== undefined) {
        agendaEvents.push({
          type: "agenda",
          start: agendaStartTime,
          end: agendaEndTime ?? agendaStartTime + 10,
          title: item.title,
          item_order: item.item_order,
          id: `agenda-${item.id}`,
          debate_summary: item.debate_summary,
          key_quotes: (item.meta as any)?.key_quotes,
          category: item.category,
        });
      }

      item.motions?.forEach((motion) => {
        const startTime =
          motion.time_offset_seconds ?? motionPositions.get(motion.id);
        if (startTime !== undefined) {
          motionEvents.push({
            type: "motion",
            start: startTime,
            end: startTime + 5,
            text: motion.text_content,
            summary: motion.plain_english_summary,
            result: motion.result,
            id: `motion-${motion.id}`,
            votes: motion.votes,
          });
        }
      });
    });

    return {
      speech: speechEvents,
      motions: motionEvents,
      agenda: agendaEvents,
      all: [...speechEvents, ...motionEvents, ...agendaEvents].sort(
        (a, b) => a.start - b.start,
      ),
    };
  }, [transcript, agendaItems, speakerMap]);

  const totalDuration = useMemo(() => {
    const all = events.all;
    if (all.length === 0) return 1;
    return Math.max(...all.map((e) => e.end)) + 60; // Add buffer
  }, [events]);

  // Group events into rows to prevent overlap
  const rows: SpeechEvent[][] = [[]];
  events.speech.forEach((event) => {
    let placed = false;
    for (let i = 0; i < rows.length; i++) {
      const lastInRow = rows[i][rows[i].length - 1];
      if (!lastInRow || event.start >= lastInRow.end) {
        rows[i].push(event);
        placed = true;
        break;
      }
    }
    if (!placed) rows.push([event]);
  });

  const pct = (seconds: number) => (seconds / totalDuration) * 100;
  const seek = (seconds: number) => onSeek?.(seconds);
  const canSeek = Boolean(onSeek);
  const durationMinutes = Math.round((totalDuration - 60) / 60);
  const tickCount = 4;

  const focusTime =
    hoveredEvent?.type === "speech" && hoveredSegment
      ? hoveredSegment.start
      : hoveredEvent?.start;

  return (
    <section className="rounded-2xl border border-zinc-200 bg-surface p-5 shadow-sm">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-bold tracking-tight text-zinc-900">Meeting timeline</h2>
        <span className="text-xs tabular-nums text-zinc-500">
          {events.speech.length} speaking turns · about {durationMinutes} min
        </span>
      </div>
      <p className="mb-5 text-sm text-zinc-500">
        Each bar is someone speaking. Hover for details{canSeek ? ", click to jump the video there" : ""}.
      </p>

      <div className="relative w-full pb-2 pt-9" onMouseLeave={() => setHoveredEvent(null)}>
        {/* Time ticks */}
        <div className="pointer-events-none absolute inset-0">
          {Array.from({ length: tickCount + 1 }, (_, i) => i / tickCount).map((fraction) => (
            <div
              key={fraction}
              className="absolute top-0 h-full border-l border-zinc-100"
              style={{ left: `${fraction * 100}%` }}
            >
              <span
                className={cn(
                  "absolute top-0 text-[11px] tabular-nums text-zinc-400",
                  fraction === 1 ? "right-1" : fraction === 0 ? "left-1" : "-translate-x-1/2",
                )}
              >
                {formatTimestamp(fraction * totalDuration)}
              </span>
            </div>
          ))}
        </div>

        {/* Playhead */}
        {currentTime != null && currentTime >= 0 && currentTime <= totalDuration && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 top-6 z-10 w-0.5 -translate-x-1/2 bg-zinc-900/70"
            style={{ left: `${pct(currentTime)}%` }}
          >
            <span className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rounded-full bg-zinc-900" />
          </div>
        )}

        {/* Agenda item starts */}
        <div className="relative mb-2 h-4">
          {events.agenda.map((agenda) => (
            <button
              key={agenda.id}
              type="button"
              aria-label={`Agenda item ${cleanOrder(agenda.item_order)}: ${displayTitle(agenda.title)} at ${formatTimestamp(agenda.start)}`}
              className={cn(
                "absolute top-0 h-4 w-2 -translate-x-1/2 rounded-sm bg-brand-600 ring-2 ring-surface transition-transform hover:scale-125 focus-visible:outline-none focus-visible:ring-brand-300",
                hoveredEvent?.id === agenda.id && "scale-125",
              )}
              style={{ left: `${pct(agenda.start)}%` }}
              onMouseEnter={() => {
                setHoveredSegment(null);
                setHoveredEvent(agenda);
              }}
              onFocus={() => setHoveredEvent(agenda)}
              onClick={() => seek(agenda.start)}
            />
          ))}
        </div>

        {/* Speaking turns */}
        <div className="relative space-y-1">
          {rows.map((row, rowIndex) => (
            <div key={rowIndex} className="relative h-6 w-full">
              {row.map((turn) => {
                const colorIdx = getSpeakerColorIndex(turn.speaker);
                const dimmed = hoveredEvent && hoveredEvent.id !== turn.id;
                return (
                  <div
                    key={turn.id}
                    className={cn(
                      "absolute top-0 flex h-full overflow-hidden rounded",
                      SPEAKER_BG_LIGHT_COLORS[colorIdx],
                      dimmed ? "opacity-40" : "opacity-100",
                      canSeek && "cursor-pointer",
                    )}
                    style={{
                      left: `${pct(turn.start)}%`,
                      width: `${Math.max(pct(turn.end - turn.start), 0.2)}%`,
                    }}
                    onMouseEnter={() => setHoveredEvent(turn)}
                    onMouseLeave={() => {
                      setHoveredSegment(null);
                      onSegmentHover?.(null);
                    }}
                  >
                    <div className={cn("absolute inset-y-0 left-0 w-0.5", SPEAKER_COLORS[colorIdx])} />
                    {turn.segments.map((seg) => (
                      <div
                        key={seg.id}
                        className={cn(
                          "h-full border-r border-surface/40 last:border-r-0 hover:bg-black/5",
                          activeSegmentId === seg.id && "bg-black/10",
                        )}
                        style={{
                          width: `${((seg.end - seg.start) / Math.max(turn.end - turn.start, 1)) * 100}%`,
                          minWidth: "2px",
                        }}
                        onMouseEnter={() => {
                          setHoveredSegment(seg);
                          onSegmentHover?.(seg.id);
                        }}
                        onClick={() => seek(seg.start)}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Motions */}
        <div className="relative mt-2 h-4">
          {events.motions.map((motion) => (
            <button
              key={motion.id}
              type="button"
              aria-label={`Motion at ${formatTimestamp(motion.start)}${motion.result ? `, ${motion.result.toLowerCase()}` : ""}`}
              className={cn(
                "absolute top-0.5 h-3 w-3 -translate-x-1/2 rounded-full ring-2 ring-surface transition-transform hover:scale-125 focus-visible:outline-none focus-visible:ring-brand-300",
                motionDotClass(motion.result),
                hoveredEvent?.id === motion.id && "scale-125",
              )}
              style={{ left: `${pct(motion.start)}%` }}
              onMouseEnter={() => {
                setHoveredSegment(null);
                setHoveredEvent(motion);
              }}
              onFocus={() => setHoveredEvent(motion)}
              onClick={() => seek(motion.start)}
            />
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-1.5 rounded-sm bg-brand-600" /> Agenda item starts
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" /> Motion carried
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-red-500" /> Motion defeated
        </span>
      </div>

      {/* Detail panel */}
      <div className="mt-4 min-h-[96px] rounded-xl border border-zinc-200 bg-zinc-50/60 p-4">
        {hoveredEvent ? (
          <div>
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <div className="min-w-0">
                <p className="text-xs tabular-nums text-zinc-500">
                  {hoveredEvent.type === "speech" && hoveredSegment
                    ? `${formatTimestamp(hoveredSegment.start)} – ${formatTimestamp(hoveredSegment.end)}`
                    : hoveredEvent.type === "speech"
                      ? `${formatTimestamp(hoveredEvent.start)} – ${formatTimestamp(hoveredEvent.end)}`
                      : formatTimestamp(hoveredEvent.start)}
                  {hoveredEvent.type === "agenda" && hoveredEvent.category && ` · ${hoveredEvent.category}`}
                  {hoveredEvent.type === "speech" &&
                    ` · ${hoveredEvent.segments.length} ${hoveredEvent.segments.length === 1 ? "segment" : "segments"}`}
                </p>
                <h3 className="mt-0.5 flex flex-wrap items-center gap-2 text-sm font-semibold text-zinc-900">
                  {hoveredEvent.type === "speech" && (
                    <span
                      className={cn("h-2 w-2 rounded-full", SPEAKER_COLORS[getSpeakerColorIndex(hoveredEvent.speaker)])}
                      aria-hidden="true"
                    />
                  )}
                  {hoveredEvent.type === "motion" ? (
                    "Motion"
                  ) : hoveredEvent.type === "agenda" ? (
                    `${cleanOrder(hoveredEvent.item_order) ? cleanOrder(hoveredEvent.item_order) + " · " : ""}${displayTitle(hoveredEvent.title)}`
                  ) : (
                    <SpeakerName name={hoveredEvent.speaker} />
                  )}
                  {hoveredEvent.type === "motion" && <MotionOutcomeBadge result={hoveredEvent.result} />}
                </h3>
              </div>
              {canSeek && focusTime != null && (
                <button
                  type="button"
                  onClick={() => seek(focusTime)}
                  className="shrink-0 text-sm font-medium text-brand-700 hover:text-brand-800"
                >
                  Watch from <span className="tabular-nums">{formatTimestamp(focusTime)}</span>
                </button>
              )}
            </div>

            {hoveredEvent.type === "speech" && hoveredSegment && (
              <p className="mt-2 line-clamp-4 text-sm leading-relaxed text-zinc-700">
                {hoveredSegment.text}
              </p>
            )}

            {hoveredEvent.type === "motion" && (
              <div className="mt-2 space-y-2 text-sm">
                <p className="leading-relaxed text-zinc-700">
                  {hoveredEvent.summary || hoveredEvent.text}
                </p>
                {hoveredEvent.votes && hoveredEvent.votes.length > 0 && (
                  <p className="text-xs text-zinc-500">
                    {(() => {
                      const yes = hoveredEvent.votes!.filter((v: any) => v.vote === "Yes");
                      const no = hoveredEvent.votes!.filter((v: any) => v.vote === "No");
                      return (
                        <>
                          <span className="text-emerald-700">
                            For: {yes.map((v: any) => lastName(v.person?.name)).join(", ") || "none"}
                          </span>
                          {no.length > 0 && (
                            <span className="text-red-700">
                              {" · "}Against: {no.map((v: any) => lastName(v.person?.name)).join(", ")}
                            </span>
                          )}
                        </>
                      );
                    })()}
                  </p>
                )}
              </div>
            )}

            {hoveredEvent.type === "agenda" && (
              <div className="mt-2 space-y-2 text-sm">
                {hoveredEvent.debate_summary && (
                  <p className="line-clamp-4 leading-relaxed text-zinc-700">{hoveredEvent.debate_summary}</p>
                )}
                {hoveredEvent.key_quotes && hoveredEvent.key_quotes.length > 0 && (
                  <ul className="space-y-1.5">
                    {hoveredEvent.key_quotes.slice(0, 2).map((quote: any, qIdx: number) => (
                      <li key={qIdx} className="border-l-2 border-zinc-300 pl-3 text-zinc-600">
                        “{quote.text}”
                        {quote.speaker && <span className="block text-xs text-zinc-500">{quote.speaker}</span>}
                      </li>
                    ))}
                  </ul>
                )}
                {!hoveredEvent.debate_summary && !(hoveredEvent.key_quotes && hoveredEvent.key_quotes.length > 0) && (
                  <p className="text-zinc-500">No discussion summary for this item.</p>
                )}
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-zinc-500">
            Hover over a bar or marker to see who was speaking, which agenda item was up, or how a motion went.
          </p>
        )}
      </div>
    </section>
  );
}
