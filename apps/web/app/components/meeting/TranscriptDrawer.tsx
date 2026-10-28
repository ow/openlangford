import { useMemo, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { SearchField } from "../ui/search-field";
import { cn } from "../../lib/utils";
import type { TranscriptSegment } from "../../lib/types";
import { formatTimestamp } from "../../lib/timeline-utils";
import { getSpeakerColorIndex, SPEAKER_COLORS } from "../../lib/colors";
import {
  splitTranscript,
  findCurrentSubSegment,
} from "../../lib/transcript-utils";

interface TranscriptDrawerProps {
  isOpen: boolean;
  textStatus?: "idle" | "loading" | "ready" | "error";
  onRetryText?: () => void;
  onClose: () => void;
  transcript: TranscriptSegment[];
  focusedSegmentId?: number | null;
  currentTime: number;
  onSegmentClick: (time: number) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  resolveSpeakerName: (seg: { person?: { name: string } | null; speaker_name?: string | null }) => string;
}

export function TranscriptDrawer({
  isOpen,
  textStatus,
  onRetryText,
  onClose,
  transcript,
  focusedSegmentId,
  currentTime,
  onSegmentClick,
  searchQuery,
  onSearchChange,
  resolveSpeakerName,
}: TranscriptDrawerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isScrollingProgrammatically = useRef(false);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoScrollEnabled = useRef(true);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  // Split transcript into sentence-level sub-segments
  const subSegments = useMemo(() => splitTranscript(transcript), [transcript]);

  // Filter sub-segments by search
  const filteredSubSegments = subSegments.filter((sub) => {
    if (!searchQuery) return true;
    const text = sub.text_content.toLowerCase();
    const speaker = resolveSpeakerName(sub).toLowerCase();
    const query = searchQuery.toLowerCase();
    return text.includes(query) || speaker.includes(query);
  });

  useEffect(() => {
    if (!isOpen || focusedSegmentId == null) return;
    const target = subSegments.find((sub) => sub.parentId === focusedSegmentId);
    const container = containerRef.current;
    const element = target && document.getElementById(`drawer-segment-${target.id}`);
    if (!container || !element) return;

    autoScrollEnabled.current = false;
    container.scrollTop = element.offsetTop - container.offsetTop - container.clientHeight / 3;
  }, [isOpen, focusedSegmentId, subSegments]);

  // Auto-scroll to current sub-segment
  useEffect(() => {
    if (!isOpen || focusedSegmentId != null || !autoScrollEnabled.current) return;

    const currentSub = findCurrentSubSegment(subSegments, currentTime);

    if (currentSub) {
      const element = document.getElementById(
        `drawer-segment-${currentSub.id}`
      );
      const container = containerRef.current;

      if (element && container) {
        const containerRect = container.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();
        const relativeTop = elementRect.top - containerRect.top;

        // Only scroll if element is outside visible area
        if (
          relativeTop < 0 ||
          relativeTop > containerRect.height - elementRect.height
        ) {
          isScrollingProgrammatically.current = true;

          container.scrollTo({
            top: container.scrollTop + relativeTop - containerRect.height / 3,
            behavior: "smooth",
          });

          if (scrollTimeoutRef.current)
            clearTimeout(scrollTimeoutRef.current);
          scrollTimeoutRef.current = setTimeout(() => {
            isScrollingProgrammatically.current = false;
          }, 500);
        }
      }
    }
  }, [currentTime, subSegments, isOpen, focusedSegmentId]);

  // Handle user scroll
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      if (isScrollingProgrammatically.current) return;
      autoScrollEnabled.current = false;
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  const jumpToLive = () => {
    const currentSub = findCurrentSubSegment(subSegments, currentTime);
    if (currentSub) {
      const element = document.getElementById(
        `drawer-segment-${currentSub.id}`
      );
      if (element) {
        isScrollingProgrammatically.current = true;
        element.scrollIntoView({ behavior: "smooth", block: "center" });

        if (scrollTimeoutRef.current)
          clearTimeout(scrollTimeoutRef.current);
        scrollTimeoutRef.current = setTimeout(() => {
          isScrollingProgrammatically.current = false;
          autoScrollEnabled.current = true;
        }, 500);
      }
    }
    autoScrollEnabled.current = true;
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-zinc-900/40 transition-opacity",
          isOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        onClick={onClose}
      />

      {/* Drawer */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Transcript"
        aria-hidden={!isOpen}
        className={cn(
          "fixed top-0 right-0 z-50 flex h-full w-full max-w-md flex-col border-l border-zinc-200 bg-surface shadow-xl transition-transform duration-300",
          isOpen ? "translate-x-0" : "translate-x-full"
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-zinc-100 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-900">Transcript</h2>
            <p className="text-xs text-zinc-500">
              {searchQuery
                ? `${filteredSubSegments.length.toLocaleString()} matching lines`
                : `${filteredSubSegments.length.toLocaleString()} lines · select one to play from there`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close transcript"
            className="rounded-lg p-2 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {isOpen && (textStatus === "loading" || textStatus === "error") && (
          <div role="status" className="px-4 py-3 text-sm text-zinc-600">
            {textStatus === "loading" ? "Loading transcript…" : <>Transcript could not load. <button type="button" onClick={onRetryText} className="underline">Try again</button></>}
          </div>
        )}

        {/* Search */}
        <div className="border-b border-zinc-100 px-4 py-3">
          <SearchField
            value={searchQuery}
            onValueChange={onSearchChange}
            placeholder="Search transcript"
            aria-label="Search transcript"
          />
        </div>

        {/* Follow playback */}
        {!autoScrollEnabled.current && currentTime > 0 && (
          <div className="border-b border-zinc-100 px-4 py-2">
            <button
              type="button"
              onClick={jumpToLive}
              className="w-full rounded-lg bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 transition-colors hover:bg-brand-100"
            >
              Follow playback
            </button>
          </div>
        )}

        {/* Transcript List */}
        <div
          ref={containerRef}
          className="flex-1 overflow-y-auto scroll-smooth"
        >
          <div className="p-3">
            {filteredSubSegments.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
                {searchQuery
                  ? `Nothing in the transcript matches “${searchQuery}”.`
                  : "No transcript is available for this meeting yet."}
              </div>
            ) : (
              filteredSubSegments.map((sub, idx) => {
                const speakerName = resolveSpeakerName(sub);
                const colorIdx = getSpeakerColorIndex(speakerName);
                const isActive =
                  currentTime >= sub.start_time &&
                  currentTime < sub.end_time;
                const isLinked = focusedSegmentId === sub.parentId;
                const prevSub = idx > 0 ? filteredSubSegments[idx - 1] : null;
                const showSpeaker = !prevSub || prevSub.parentId !== sub.parentId || prevSub.speaker_name !== sub.speaker_name;

                return (
                  <div
                    key={sub.id}
                    id={`drawer-segment-${sub.id}`}
                    onClick={() => onSegmentClick(sub.start_time)}
                    className={cn(
                      "cursor-pointer px-3 py-2 transition-colors",
                      isLinked
                        ? "bg-amber-50/80 shadow-[inset_2px_0_0_var(--color-amber-400)]"
                        : isActive
                          ? "rounded-lg bg-brand-50"
                          : "rounded-lg hover:bg-zinc-50",
                      showSpeaker && idx > 0 && "mt-2"
                    )}
                  >
                    {showSpeaker && (
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className={cn(
                            "h-2 w-2 shrink-0 rounded-full",
                            SPEAKER_COLORS[colorIdx]
                          )}
                        />
                        <span className="truncate text-xs font-medium text-zinc-700">
                          {speakerName}
                        </span>
                        <span className="ml-auto shrink-0 text-xs tabular-nums text-zinc-400">
                          {formatTimestamp(sub.start_time)}
                        </span>
                      </div>
                    )}
                    <p
                      className={cn(
                        "pl-4 text-sm leading-relaxed",
                        isActive || isLinked ? "text-zinc-900" : "text-zinc-600"
                      )}
                    >
                      <HighlightText
                        text={sub.text_content}
                        query={searchQuery}
                      />
                    </p>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query || !text) return <>{text}</>;

  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark
            key={i}
            className="rounded-sm bg-amber-200 px-0.5 text-zinc-900"
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}
