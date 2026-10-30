import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import type { AgendaItem, TranscriptSegment } from "../../lib/types";
import {
  getAgendaBlocksWithMotions,
  AGENDA_COLORS,
  getAgendaColorIndex,
  formatTimestamp,
  type AgendaBlockWithMotions,
  type EmbeddedMotion,
} from "../../lib/timeline-utils";
import { normalizeMotionResult, OUTCOME_LABELS } from "../../lib/motion-utils";
import { displayTitle } from "../../lib/display-text";
import { SpeakerName } from "../ui/speaker-name";

interface EnhancedVideoScrubberProps {
  duration: number;
  currentTime: number;
  agendaItems: AgendaItem[];
  transcript: TranscriptSegment[];
  onSeek: (time: number) => void;
  onAgendaClick: (itemId: number) => void;
  resolveSpeakerName: (seg: TranscriptSegment) => string;
  className?: string;
}

interface HoverInfo {
  label: string;
  subLabel?: string;
  detail?: string;
  time: number;
  x: number; // percent across the track
}

function cleanOrder(order?: string | null) {
  return (order || "").trim().replace(/^[\s(.)]+|[\s(.)]+$/g, "");
}

export function EnhancedVideoScrubber({
  duration,
  currentTime,
  agendaItems,
  transcript,
  onSeek,
  onAgendaClick,
  resolveSpeakerName,
  className,
}: EnhancedVideoScrubberProps) {
  const [hovered, setHovered] = useState<HoverInfo | null>(null);
  // Centred on the hovered point, then nudged so it never runs past the card's edges.
  const tipRef = useRef<HTMLDivElement>(null);
  const [tipShift, setTipShift] = useState(0);
  useLayoutEffect(() => {
    const tip = tipRef.current;
    const box = tip?.offsetParent?.getBoundingClientRect();
    if (!tip || !box) return;
    const rect = tip.getBoundingClientRect();
    const left = rect.left - tipShift;
    const right = rect.right - tipShift;
    const gutter = 8;
    const next = left < box.left + gutter ? box.left + gutter - left : right > box.right - gutter ? box.right - gutter - right : 0;
    if (Math.abs(next - tipShift) > 0.5) setTipShift(next);
  }, [hovered?.x, hovered?.label, tipShift]);

  const agendaBlocks = useMemo(() => getAgendaBlocksWithMotions(agendaItems), [agendaItems]);

  const activeAgendaBlock = useMemo(
    () => agendaBlocks.find((b) => currentTime >= b.startTime && currentTime < b.endTime),
    [agendaBlocks, currentTime],
  );

  const activeSegment = useMemo(
    () => transcript.find((s) => currentTime >= s.start_time && currentTime < s.end_time),
    [transcript, currentTime],
  );

  if (duration === 0) return null;

  const playheadPosition = Math.min(100, (currentTime / duration) * 100);

  const timeAtPointer = (e: React.MouseEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const percent = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    return { percent, time: percent * duration };
  };

  return (
    <div className={cn("relative border-t border-zinc-200 bg-surface px-4 pb-2.5 pt-3", className)}>
      {/* Tooltip */}
      {hovered && (
        <div
          ref={tipRef}
          className="pointer-events-none absolute bottom-full z-50 mb-1"
          style={{ left: `${hovered.x}%`, transform: `translateX(calc(-50% + ${tipShift}px))` }}
        >
          <div className="max-w-xs rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white shadow-lg">
            <div className="font-medium leading-snug">{hovered.label}</div>
            {hovered.subLabel && <div className="text-xs text-zinc-400">{hovered.subLabel}</div>}
            {hovered.detail && (
              <div className="mt-1 line-clamp-3 text-xs leading-relaxed text-zinc-300">{hovered.detail}</div>
            )}
            <div className="mt-1 text-xs tabular-nums text-zinc-400">{formatTimestamp(hovered.time)}</div>
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        {/* Agenda blocks */}
        {agendaBlocks.length > 0 && (
          <div
            className="relative h-7 cursor-pointer overflow-hidden rounded-md bg-zinc-100"
            onClick={(e) => onSeek(timeAtPointer(e).time)}
          >
            {agendaBlocks.map((block, idx) => {
              const left = (block.startTime / duration) * 100;
              const width = ((block.endTime - block.startTime) / duration) * 100;
              return (
                <AgendaBlock
                  key={block.id}
                  block={block}
                  colorIdx={getAgendaColorIndex(idx)}
                  left={left}
                  width={width}
                  isActive={activeAgendaBlock?.id === block.id}
                  onSeek={onSeek}
                  onAgendaClick={onAgendaClick}
                  onHover={setHovered}
                  onHoverEnd={() => setHovered(null)}
                />
              );
            })}

            {/* Played overlay + playhead */}
            <div
              className="pointer-events-none absolute inset-y-0 left-0 z-10 bg-brand-500/10"
              style={{ width: `${playheadPosition}%` }}
            />
            <div
              className="pointer-events-none absolute top-0 z-20 h-full w-0.5 -translate-x-1/2 bg-zinc-900"
              style={{ left: `${playheadPosition}%` }}
            />
          </div>
        )}

        {/* Progress / seek bar */}
        <div
          className="group/seek relative flex h-3 cursor-pointer items-center"
          onClick={(e) => onSeek(timeAtPointer(e).time)}
          onMouseMove={(e) => {
            const { percent, time } = timeAtPointer(e);
            const seg = transcript.find((s) => time >= s.start_time && time < s.end_time);
            setHovered({
              label: seg ? resolveSpeakerName(seg) : formatTimestamp(time),
              detail: seg?.text_content,
              time,
              x: percent * 100,
            });
          }}
          onMouseLeave={() => setHovered(null)}
        >
          <div className="relative h-1 w-full overflow-hidden rounded-full bg-zinc-200 transition-[height] group-hover/seek:h-1.5">
            <div className="absolute inset-y-0 left-0 bg-brand-500" style={{ width: `${playheadPosition}%` }} />
          </div>
          <div
            className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-brand-600 shadow"
            style={{ left: `${playheadPosition}%` }}
          />
        </div>
      </div>

      {/* Now playing */}
      <div className="mt-1.5 flex items-center justify-between gap-4 text-xs text-zinc-500">
        <div className="min-w-0 flex-1 truncate">
          {activeAgendaBlock && (
            <>
              {cleanOrder(activeAgendaBlock.itemOrder) && (
                <span className="tabular-nums text-zinc-400">{cleanOrder(activeAgendaBlock.itemOrder)} </span>
              )}
              <span className="text-zinc-700">{displayTitle(activeAgendaBlock.title)}</span>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {activeSegment && (
            <SpeakerName name={resolveSpeakerName(activeSegment)} className="font-medium text-zinc-700" />
          )}
          {activeSegment && <span aria-hidden="true">·</span>}
          <span className="tabular-nums">
            {formatTimestamp(currentTime)} / {formatTimestamp(duration)}
          </span>
        </div>
      </div>
    </div>
  );
}

function AgendaBlock({
  block,
  colorIdx,
  left,
  width,
  isActive,
  onSeek,
  onAgendaClick,
  onHover,
  onHoverEnd,
}: {
  block: AgendaBlockWithMotions;
  colorIdx: number;
  left: number;
  width: number;
  isActive: boolean;
  onSeek: (time: number) => void;
  onAgendaClick: (itemId: number) => void;
  onHover: (item: HoverInfo) => void;
  onHoverEnd: () => void;
}) {
  const order = cleanOrder(block.itemOrder);
  const title = displayTitle(block.title);

  return (
    <div
      className={cn(
        "absolute top-0 h-full cursor-pointer border-r border-surface transition-opacity",
        AGENDA_COLORS[colorIdx],
        isActive ? "opacity-100" : "opacity-40 hover:opacity-70",
      )}
      style={{ left: `${left}%`, width: `${Math.max(width, 0.5)}%` }}
      onClick={(e) => {
        e.stopPropagation();
        onAgendaClick(block.id);
        onSeek(block.startTime);
      }}
      onMouseEnter={() =>
        onHover({
          label: order ? `${order} ${title}` : title,
          subLabel:
            block.motions.length > 0
              ? `${block.motions.length} motion${block.motions.length > 1 ? "s" : ""}`
              : undefined,
          detail: block.summary,
          time: block.startTime,
          x: left + width / 2,
        })
      }
      onMouseLeave={onHoverEnd}
    >
      {width > 2.5 && order && (
        <span
          className={cn(
            "absolute left-1 top-1 text-[11px] leading-none tabular-nums",
            isActive ? "text-white" : "text-zinc-700",
          )}
        >
          {order}
        </span>
      )}

      {block.motions.map((motion) => (
        <MotionMarker
          key={motion.id}
          motion={motion}
          blockLeft={left}
          blockWidth={width}
          onSeek={onSeek}
          onHover={onHover}
          onHoverEnd={onHoverEnd}
        />
      ))}
    </div>
  );
}

function MotionMarker({
  motion,
  blockLeft,
  blockWidth,
  onSeek,
  onHover,
  onHoverEnd,
}: {
  motion: EmbeddedMotion;
  blockLeft: number;
  blockWidth: number;
  onSeek: (time: number) => void;
  onHover: (item: HoverInfo) => void;
  onHoverEnd: () => void;
}) {
  const positionInBlock = motion.relativePosition * 100;
  const absoluteX = blockLeft + motion.relativePosition * blockWidth;

  const outcome = normalizeMotionResult(motion.result);
  const resultLabel = outcome ? `Motion ${OUTCOME_LABELS[outcome].toLowerCase()}` : "Motion";
  const subLabel = [motion.mover, motion.seconder].filter(Boolean).join(" / ");

  return (
    <div
      className="absolute bottom-1 z-10 -ml-1 h-2 w-2 cursor-pointer transition-transform hover:scale-150"
      style={{ left: `clamp(4px, ${positionInBlock}%, calc(100% - 4px))` }}
      onClick={(e) => {
        e.stopPropagation();
        onSeek(motion.time);
      }}
      onMouseEnter={(e) => {
        e.stopPropagation();
        onHover({
          label: resultLabel,
          subLabel: subLabel || undefined,
          detail: motion.text || undefined,
          time: motion.time,
          x: absoluteX,
        });
      }}
      onMouseLeave={(e) => {
        e.stopPropagation();
        onHoverEnd();
      }}
    >
      <div
        className={cn(
          "h-full w-full rounded-full ring-1 ring-surface",
          outcome === "passed"
            ? "bg-emerald-500"
            : outcome === "failed"
              ? "bg-red-500"
              : outcome === "tabled"
                ? "bg-amber-500"
                : "bg-zinc-500",
        )}
      />
    </div>
  );
}
