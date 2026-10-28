import { useState, useMemo, useEffect, useRef } from "react";
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Loader2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Drawer, DrawerContent, DrawerTitle } from "../ui/drawer";
import type { AgendaItem, TranscriptSegment, Motion, Vote } from "../../lib/types";
import { formatTimestamp, findAgendaItemForTime } from "../../lib/timeline-utils";
import { getSpeakerColorIndex, SPEAKER_COLORS } from "../../lib/colors";
import {
  splitTranscript,
  findCurrentSubSegment,
  type SubSegment,
} from "../../lib/transcript-utils";
import { displayTitle, lastName } from "../../lib/display-text";
import { EnhancedVideoScrubber } from "./EnhancedVideoScrubber";
import { MotionOutcomeBadge } from "../motion-outcome-badge";

interface VideoWithSidebarProps {
  videoPlayer: {
    videoRef: React.RefObject<HTMLVideoElement | null>;
    audioRef: React.RefObject<HTMLAudioElement | null>;
    videoEnabled: boolean;
    setVideoEnabled: (enabled: boolean) => void;
    currentTime: number;
    duration: number;
    isPlaying: boolean;
    isLoading: boolean;
    volume: number;
    playbackRate: number;
    togglePlay: () => void;
    toggleMute: () => void;
    seekTo: (time: number) => void;
    setVolume: (volume: number) => void;
    setPlaybackRate: (rate: number) => void;
  };
  directVideoUrl?: string | null;
  directAudioUrl?: string | null;
  meeting: { id: number; video_url?: string };
  agendaItems: AgendaItem[];
  transcript: TranscriptSegment[];
  meetingDuration: number;
  resolveSpeakerName: (seg: { person?: { name: string } | null; speaker_name?: string | null }) => string;
  showCaption: boolean;
  setShowCaption: (show: boolean) => void;
  onVideoError?: () => void;
  onTranscriptOpen?: () => void;
}

type SidebarMode = "agenda" | "transcript";

/** "5.1." / "(a)" → "5.1" / "a" */
function cleanOrder(order?: string | null) {
  return (order || "").trim().replace(/^[\s(.)]+|[\s(.)]+$/g, "");
}

/**
 * Items whose discussion start time is actually known. A 0 start is only
 * trusted when exactly one item has it (the genuine start of the meeting);
 * several items at 0:00 means timing was never extracted.
 */
function getTimedItemIds(items: AgendaItem[]): Set<number> {
  const ids = new Set<number>();
  const zeros: AgendaItem[] = [];
  for (const item of items) {
    const start = item.discussion_start_time;
    if (start == null) continue;
    if (start > 0) ids.add(item.id);
    else if (start === 0) zeros.push(item);
  }
  if (zeros.length === 1) ids.add(zeros[0].id);
  return ids;
}

const RATES = [1, 1.5, 2];

export function VideoWithSidebar({
  videoPlayer,
  directVideoUrl,
  directAudioUrl,
  meeting,
  agendaItems,
  transcript,
  meetingDuration,
  resolveSpeakerName,
  showCaption,
  setShowCaption,
  onVideoError,
  onTranscriptOpen,
}: VideoWithSidebarProps) {
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("agenda");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const transcriptContainerRef = useRef<HTMLDivElement>(null);
  const mobileTranscriptRef = useRef<HTMLDivElement>(null);
  const isScrollingProgrammatically = useRef(false);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);

  const timedIds = useMemo(() => getTimedItemIds(agendaItems), [agendaItems]);
  const timedAgendaItems = useMemo(
    () => agendaItems.filter((i) => timedIds.has(i.id)),
    [agendaItems, timedIds],
  );

  // Find current agenda item based on video time
  const currentAgendaItem = useMemo(() => {
    return findAgendaItemForTime(timedAgendaItems, videoPlayer.currentTime);
  }, [timedAgendaItems, videoPlayer.currentTime]);

  // Split transcript into sentence-level sub-segments
  const subSegments = useMemo(() => splitTranscript(transcript), [transcript]);

  // Find current sub-segment (sentence-level) for CC overlay
  const currentSubSegment = useMemo(() => {
    return findCurrentSubSegment(subSegments, videoPlayer.currentTime);
  }, [subSegments, videoPlayer.currentTime]);

  // Auto-scroll transcript to current sub-segment (works for both desktop sidebar and mobile drawer)
  useEffect(() => {
    if (sidebarMode !== "transcript" || !autoScrollEnabled) return;

    const currentSub = findCurrentSubSegment(subSegments, videoPlayer.currentTime);
    if (!currentSub) return;

    // Use whichever container is currently active
    const container =
      (mobileDrawerOpen && mobileTranscriptRef.current) ||
      transcriptContainerRef.current;
    if (!container) return;

    // Scope element lookup to the active container
    const element = container.querySelector(
      `[id="sidebar-seg-${currentSub.id}"]`,
    );
    if (!element) return;

    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const relativeTop = elementRect.top - containerRect.top;

    if (
      relativeTop < 0 ||
      relativeTop > containerRect.height - elementRect.height
    ) {
      isScrollingProgrammatically.current = true;

      container.scrollTo({
        top: container.scrollTop + relativeTop - containerRect.height / 3,
        behavior: "smooth",
      });

      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = setTimeout(() => {
        isScrollingProgrammatically.current = false;
      }, 500);
    }
  }, [videoPlayer.currentTime, subSegments, sidebarMode, autoScrollEnabled, mobileDrawerOpen]);

  // Handle user scroll - disconnect from auto-scroll when user manually scrolls
  useEffect(() => {
    const container = transcriptContainerRef.current;
    if (!container || sidebarMode !== "transcript") return;

    const handleScroll = () => {
      if (isScrollingProgrammatically.current) return;
      setAutoScrollEnabled(false);
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [sidebarMode, sidebarCollapsed]);

  // Inline scroll handler for mobile drawer (avoids ref timing issues with portals)
  const handleMobileTranscriptScroll = () => {
    if (sidebarMode !== "transcript" || isScrollingProgrammatically.current) return;
    setAutoScrollEnabled(false);
  };

  const jumpToLive = () => {
    setAutoScrollEnabled(true);
  };

  const seek = (time: number) => {
    if (!videoPlayer.videoEnabled) {
      videoPlayer.setVideoEnabled(true);
      setTimeout(() => videoPlayer.seekTo(time), 100);
    } else {
      videoPlayer.seekTo(time);
    }
  };

  const selectMode = (mode: SidebarMode) => {
    setSidebarMode(mode);
    if (mode === "transcript") {
      setAutoScrollEnabled(true);
      onTranscriptOpen?.();
    }
  };

  const cycleRate = () => {
    const nextIdx = (RATES.indexOf(videoPlayer.playbackRate) + 1) % RATES.length;
    videoPlayer.setPlaybackRate(RATES[nextIdx]);
  };

  if (!meeting.video_url) {
    return null;
  }

  const totalDuration = videoPlayer.duration || meetingDuration;
  const captionSpeaker = currentSubSegment ? resolveSpeakerName(currentSubSegment) : "";

  const sidebarBody = (scrollRef: React.RefObject<HTMLDivElement | null>) =>
    sidebarMode === "agenda" ? (
      <AgendaList
        agendaItems={agendaItems}
        timedIds={timedIds}
        currentAgendaItem={currentAgendaItem}
        scrollRef={scrollRef}
        onSeek={seek}
      />
    ) : (
      <TranscriptSidebarContent
        subSegments={subSegments}
        currentTime={videoPlayer.currentTime}
        onSeek={seek}
        resolveSpeakerName={resolveSpeakerName}
        autoScrollEnabled={autoScrollEnabled}
        onJumpToLive={jumpToLive}
      />
    );

  return (
    <div className="overflow-hidden rounded-b-2xl border border-zinc-200 bg-surface shadow-sm">
      <div className="flex flex-col lg:flex-row">
        {/* Video Player */}
        <div
          className={cn(
            "relative bg-black lg:aspect-video",
            sidebarCollapsed ? "flex-1" : "lg:w-2/3",
          )}
        >
          <div className="group relative aspect-video bg-black lg:absolute lg:inset-0 lg:aspect-auto">
            {/* Video Loading State */}
            {!directVideoUrl && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-900">
                <div className="flex flex-col items-center gap-3">
                  <Loader2 className="h-6 w-6 animate-spin text-zinc-500" aria-hidden="true" />
                  <span className="text-sm text-zinc-400">Connecting to video…</span>
                </div>
              </div>
            )}

            <video
              key={directVideoUrl}
              ref={videoPlayer.videoRef}
              src={directVideoUrl || undefined}
              className="h-full w-full"
              onClick={videoPlayer.togglePlay}
              playsInline
              preload="auto"
              muted={!!directAudioUrl || videoPlayer.volume === 0}
              onError={() => {
                if (!directVideoUrl) return;
                console.error("Video failed to load.");
                onVideoError?.();
              }}
            />

            {directAudioUrl && (
              <audio
                ref={videoPlayer.audioRef}
                src={directAudioUrl}
                className="hidden"
                preload="auto"
                muted={videoPlayer.volume === 0}
              />
            )}

            {/* Play overlay */}
            {directVideoUrl && !videoPlayer.videoEnabled && (
              <button
                type="button"
                aria-label="Play meeting video"
                className="group/play absolute inset-0 z-10 flex items-center justify-center bg-black/30 transition-colors hover:bg-black/20"
                onClick={(e) => {
                  e.stopPropagation();
                  videoPlayer.setVideoEnabled(true);
                  setTimeout(() => videoPlayer.togglePlay(), 100);
                }}
              >
                <span className="flex h-16 w-16 items-center justify-center rounded-full bg-surface/90 text-zinc-900 shadow-lg transition-transform group-hover/play:scale-105">
                  <Play className="ml-1 h-7 w-7 fill-current" />
                </span>
              </button>
            )}

            {/* Loading Spinner */}
            {videoPlayer.isLoading && videoPlayer.videoEnabled && (
              <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
                <div className="rounded-full bg-black/50 p-3 backdrop-blur-sm">
                  <Loader2 className="h-7 w-7 animate-spin text-white" />
                </div>
              </div>
            )}

            {/* Captions */}
            {showCaption && currentSubSegment && videoPlayer.videoEnabled && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center p-2 lg:bottom-16 lg:p-4">
                <div className="max-w-2xl rounded-lg bg-black/75 px-3 py-1.5 text-center backdrop-blur-sm lg:px-5 lg:py-2.5">
                  <div className="mb-0.5 flex items-center justify-center gap-1.5">
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        SPEAKER_COLORS[getSpeakerColorIndex(captionSpeaker)],
                      )}
                    />
                    <span className="text-xs font-medium text-white/70">{captionSpeaker}</span>
                  </div>
                  <p className="text-xs leading-snug text-white sm:text-sm lg:text-base">
                    {currentSubSegment.text_content}
                  </p>
                </div>
              </div>
            )}

            {/* Video Controls - Desktop (hover) */}
            {videoPlayer.videoEnabled && directVideoUrl && (
              <div className="absolute inset-x-0 bottom-0 z-30 hidden bg-gradient-to-t from-black/80 to-transparent p-4 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 lg:block">
                <div className="flex items-center justify-between text-white">
                  <div className="flex items-center gap-3">
                    <PlayPauseButton isPlaying={videoPlayer.isPlaying} onClick={videoPlayer.togglePlay} />
                    <div className="flex items-center gap-2">
                      <MuteButton muted={videoPlayer.volume === 0} onClick={videoPlayer.toggleMute} />
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.1}
                        value={videoPlayer.volume}
                        aria-label="Volume"
                        onChange={(e) => videoPlayer.setVolume(parseFloat(e.target.value))}
                        className="h-1 w-20 cursor-pointer accent-white"
                      />
                    </div>
                    <span className="text-xs tabular-nums text-white/80">
                      {formatTimestamp(videoPlayer.currentTime)} / {formatTimestamp(totalDuration)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <CaptionButton on={showCaption} onClick={() => setShowCaption(!showCaption)} />
                    <RateButton rate={videoPlayer.playbackRate} onClick={cycleRate} />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Mobile Controls - Always visible */}
          {videoPlayer.videoEnabled && directVideoUrl && (
            <div className="bg-zinc-900 px-3 pb-2 pt-1 text-white lg:hidden">
              {totalDuration > 0 && (
                <input
                  type="range"
                  min={0}
                  max={totalDuration}
                  step={1}
                  value={Math.min(videoPlayer.currentTime, totalDuration)}
                  aria-label="Seek"
                  onChange={(e) => videoPlayer.seekTo(parseFloat(e.target.value))}
                  className="block h-1 w-full cursor-pointer accent-brand-500"
                />
              )}
              <div className="mt-1.5 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <PlayPauseButton isPlaying={videoPlayer.isPlaying} onClick={videoPlayer.togglePlay} />
                  <MuteButton muted={videoPlayer.volume === 0} onClick={videoPlayer.toggleMute} />
                  <span className="text-xs tabular-nums text-zinc-400">
                    {formatTimestamp(videoPlayer.currentTime)} / {formatTimestamp(totalDuration)}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <CaptionButton on={showCaption} onClick={() => setShowCaption(!showCaption)} />
                  <RateButton rate={videoPlayer.playbackRate} onClick={cycleRate} />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Sidebar - Desktop only */}
        {!sidebarCollapsed && (
          <div className="relative hidden border-l border-zinc-200 bg-surface lg:block lg:w-1/3">
           <div className="absolute inset-0 flex min-h-0 flex-col overflow-hidden">
            <div className="flex items-center justify-between gap-2 border-b border-zinc-100 px-3 py-2.5">
              <ModeToggle mode={sidebarMode} onChange={selectMode} />
              <button
                type="button"
                onClick={() => setSidebarCollapsed(true)}
                className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
                aria-label="Hide agenda and transcript"
                title="Hide panel"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto" ref={transcriptContainerRef}>
              {sidebarBody(transcriptContainerRef)}
            </div>
           </div>
          </div>
        )}

        {/* Collapsed Sidebar Toggle - Desktop only */}
        {sidebarCollapsed && (
          <div className="hidden w-10 items-start justify-center border-l border-zinc-200 bg-surface pt-2.5 lg:flex">
            <button
              type="button"
              onClick={() => setSidebarCollapsed(false)}
              className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
              aria-label="Show agenda and transcript"
              title="Show panel"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {/* Mobile Sidebar Drawer */}
      <Drawer open={mobileDrawerOpen} onOpenChange={setMobileDrawerOpen}>
        <div className="flex border-t border-zinc-200 lg:hidden">
          {(["agenda", "transcript"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => {
                selectMode(mode);
                setMobileDrawerOpen(true);
              }}
              className="flex-1 px-3 py-2.5 text-sm font-medium text-zinc-700 transition-colors first:border-r first:border-zinc-200 hover:bg-zinc-50 active:bg-zinc-100"
            >
              {mode === "agenda" ? "Agenda" : "Transcript"}
            </button>
          ))}
        </div>
        <DrawerContent className="h-[80vh] bg-surface">
          <DrawerTitle className="sr-only">
            {sidebarMode === "agenda" ? "Agenda" : "Transcript"}
          </DrawerTitle>

          <div className="flex items-center justify-center border-b border-zinc-100 px-3 pb-3 pt-2">
            <ModeToggle mode={sidebarMode} onChange={selectMode} />
          </div>

          {/* min-h-0 ensures flex child constrains to allocated space so overflow scrolls properly and vaul detects scrollTop for drag */}
          <div
            className="min-h-0 flex-1 overflow-y-auto"
            ref={mobileTranscriptRef}
            onScroll={handleMobileTranscriptScroll}
          >
            {sidebarBody(mobileTranscriptRef)}
          </div>
        </DrawerContent>
      </Drawer>

      {/* Enhanced Scrubber - Desktop only */}
      {transcript.length > 0 && totalDuration > 0 && (
        <EnhancedVideoScrubber
          className="hidden lg:block"
          duration={totalDuration}
          currentTime={videoPlayer.currentTime}
          agendaItems={timedAgendaItems}
          transcript={transcript}
          onSeek={seek}
          onAgendaClick={() => {}}
          resolveSpeakerName={resolveSpeakerName}
        />
      )}
    </div>
  );
}

// ── Player controls ──────────────────────────────────────────────────────

function PlayPauseButton({ isPlaying, onClick }: { isPlaying: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={isPlaying ? "Pause" : "Play"}
      className="rounded p-0.5 transition-colors hover:text-brand-300"
    >
      {isPlaying ? <Pause className="h-5 w-5 fill-current" /> : <Play className="h-5 w-5 fill-current" />}
    </button>
  );
}

function MuteButton({ muted, onClick }: { muted: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={muted ? "Unmute" : "Mute"}
      className="rounded p-0.5 transition-colors hover:text-brand-300"
    >
      {muted ? <VolumeX className="h-4 w-4 text-zinc-400" /> : <Volume2 className="h-4 w-4" />}
    </button>
  );
}

function CaptionButton({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      aria-label={on ? "Hide captions" : "Show captions"}
      title={on ? "Hide captions" : "Show captions"}
      className={cn(
        "rounded border px-1.5 py-0.5 text-xs font-semibold leading-none transition-colors",
        on
          ? "border-surface bg-surface text-zinc-900"
          : "border-surface/40 text-white/60 hover:border-surface hover:text-white",
      )}
    >
      CC
    </button>
  );
}

function RateButton({ rate, onClick }: { rate: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Playback speed ${rate}x`}
      title="Playback speed"
      className="min-w-9 rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums text-white/80 transition-colors hover:bg-surface/10 hover:text-white"
    >
      {rate}x
    </button>
  );
}

function ModeToggle({ mode, onChange }: { mode: SidebarMode; onChange: (mode: SidebarMode) => void }) {
  return (
    <div className="flex rounded-lg bg-zinc-100 p-0.5" role="tablist">
      {(["agenda", "transcript"] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="tab"
          aria-selected={mode === m}
          onClick={() => onChange(m)}
          className={cn(
            "rounded-md px-3 py-1 text-sm font-medium transition-colors",
            mode === m ? "bg-surface text-zinc-900 shadow-sm" : "text-zinc-500 hover:text-zinc-800",
          )}
        >
          {m === "agenda" ? "Agenda" : "Transcript"}
        </button>
      ))}
    </div>
  );
}

// ── Agenda ───────────────────────────────────────────────────────────────

function AgendaList({
  agendaItems,
  timedIds,
  currentAgendaItem,
  scrollRef,
  onSeek,
}: {
  agendaItems: AgendaItem[];
  timedIds: Set<number>;
  currentAgendaItem?: AgendaItem;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onSeek: (time: number) => void;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const activeId = currentAgendaItem?.id;

  // Keep the item being discussed in view as playback moves on
  useEffect(() => {
    if (activeId == null) return;
    const container = scrollRef.current;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-agenda-id="${activeId}"]`);
    if (!container || !row) return;
    const c = container.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    if (r.top < c.top || r.bottom > c.bottom) {
      container.scrollTo({ top: container.scrollTop + (r.top - c.top) - 12, behavior: "smooth" });
    }
  }, [activeId, scrollRef]);

  if (agendaItems.length === 0) {
    return (
      <div className="p-4">
        <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
          No agenda items were recorded for this meeting.
        </div>
      </div>
    );
  }

  const anyTimed = timedIds.size > 0;

  return (
    <div>
      {!anyTimed && (
        <p className="border-b border-zinc-100 px-4 py-2.5 text-xs text-zinc-500">
          Video timing isn&rsquo;t available for these items yet.
        </p>
      )}
      <ol ref={listRef} className="divide-y divide-zinc-100">
        {agendaItems.map((item) => {
          const timed = timedIds.has(item.id);
          const isActive = item.id === activeId;
          const order = cleanOrder(item.item_order);
          const motionCount = item.motions?.length ?? 0;
          const meta = [
            motionCount > 0 && `${motionCount} motion${motionCount > 1 ? "s" : ""}`,
            item.is_controversial && "Notable",
          ].filter(Boolean);

          const rowInner = (
            <>
              <span className="w-8 shrink-0 pt-px text-xs tabular-nums text-zinc-400">{order}</span>
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block text-sm leading-snug",
                    isActive ? "font-medium text-zinc-900" : "text-zinc-700",
                  )}
                >
                  {displayTitle(item.title)}
                </span>
                {!isActive && meta.length > 0 && (
                  <span className="mt-0.5 block text-xs text-zinc-500">{meta.join(" · ")}</span>
                )}
              </span>
              {timed && (
                <span className="shrink-0 pt-px text-xs tabular-nums text-zinc-400">
                  {formatTimestamp(item.discussion_start_time!)}
                </span>
              )}
            </>
          );

          return (
            <li
              key={item.id}
              data-agenda-id={item.id}
              className={cn(isActive && "bg-brand-50/60 shadow-[inset_2px_0_0_var(--color-brand-500)]")}
            >
              {timed ? (
                <button
                  type="button"
                  data-agenda-row
                  onClick={() => onSeek(item.discussion_start_time!)}
                  aria-current={isActive || undefined}
                  title={`Play from ${formatTimestamp(item.discussion_start_time!)}`}
                  className={cn(
                    "flex w-full items-start gap-2 px-4 py-2.5 text-left transition-colors",
                    !isActive && "hover:bg-zinc-50",
                  )}
                >
                  {rowInner}
                </button>
              ) : (
                <div className="flex items-start gap-2 px-4 py-2.5">{rowInner}</div>
              )}
              {isActive && <AgendaItemDetails item={item} onSeek={onSeek} />}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function AgendaItemDetails({ item, onSeek }: { item: AgendaItem; onSeek: (time: number) => void }) {
  const motions = item.motions || [];
  const summary = item.plain_english_summary || item.description;

  if (!summary && !item.debate_summary && motions.length === 0 && !item.category) return null;

  return (
    <div className="space-y-3 pb-3.5 pl-14 pr-4">
      {summary && <p className="text-sm leading-relaxed text-zinc-600">{summary}</p>}

      {item.debate_summary && (
        <div>
          <div className="mb-0.5 text-xs font-medium text-zinc-500">Debate</div>
          <p className="text-sm leading-relaxed text-zinc-600">{item.debate_summary}</p>
        </div>
      )}

      {motions.length > 0 && (
        <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-surface">
          {motions.map((motion) => (
            <MotionRow key={motion.id} motion={motion} onSeek={onSeek} />
          ))}
        </div>
      )}

      {item.category && (
        <Badge variant="muted" className="font-normal">
          {item.category}
        </Badge>
      )}
    </div>
  );
}

function MotionRow({ motion, onSeek }: { motion: Motion; onSeek: (time: number) => void }) {
  const [showVotes, setShowVotes] = useState(false);
  const votes = motion.votes || [];
  const byVote = (v: Vote["vote"]) =>
    votes.filter((x) => x.vote === v).map((x) => lastName(x.person?.name) || "Unknown");
  const voteGroups: { label: string; names: string[]; tone: string }[] = [
    { label: "Yes", names: byVote("Yes"), tone: "text-emerald-700" },
    { label: "No", names: byVote("No"), tone: "text-red-700" },
    { label: "Abstained", names: byVote("Abstain"), tone: "text-zinc-600" },
    { label: "Recused", names: byVote("Recused"), tone: "text-zinc-600" },
  ].filter((g) => g.names.length > 0);

  return (
    <div className="px-3 py-2.5">
      <p className="text-sm leading-snug text-zinc-700">
        {motion.plain_english_summary || motion.text_content}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <MotionOutcomeBadge
          result={motion.result}
          showVoteCounts={motion.yes_votes > 0}
          yesVotes={motion.yes_votes}
          noVotes={motion.no_votes}
        />
        {motion.time_offset_seconds != null && motion.time_offset_seconds > 0 && (
          <button
            type="button"
            onClick={() => onSeek(motion.time_offset_seconds!)}
            className="font-medium tabular-nums text-brand-700 hover:text-brand-800 hover:underline"
          >
            Play from {formatTimestamp(motion.time_offset_seconds)}
          </button>
        )}
        {voteGroups.length > 0 && (
          <button
            type="button"
            onClick={() => setShowVotes(!showVotes)}
            aria-expanded={showVotes}
            className="text-zinc-500 hover:text-zinc-800"
          >
            {showVotes ? "Hide votes" : "Show votes"}
          </button>
        )}
      </div>
      {showVotes && voteGroups.length > 0 && (
        <dl className="mt-2 space-y-0.5 text-xs">
          {voteGroups.map((g) => (
            <div key={g.label} className="flex gap-1.5">
              <dt className={cn("shrink-0 font-medium", g.tone)}>{g.label}</dt>
              <dd className="text-zinc-600">{g.names.join(", ")}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

// ── Transcript (sentence-level sub-segments) ─────────────────────────────

function TranscriptSidebarContent({
  subSegments,
  currentTime,
  onSeek,
  resolveSpeakerName,
  autoScrollEnabled,
  onJumpToLive,
}: {
  subSegments: SubSegment[];
  currentTime: number;
  onSeek: (time: number) => void;
  resolveSpeakerName: (seg: { person?: { name: string } | null; speaker_name?: string | null }) => string;
  autoScrollEnabled: boolean;
  onJumpToLive: () => void;
}) {
  if (subSegments.length === 0) {
    return (
      <div className="p-4">
        <div className="rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
          No transcript is available for this meeting yet.
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      {!autoScrollEnabled && (
        <div className="sticky top-0 z-10 border-b border-zinc-100 bg-surface/95 px-3 py-2 backdrop-blur-sm">
          <button
            type="button"
            onClick={onJumpToLive}
            className="w-full rounded-lg bg-brand-50 px-3 py-1.5 text-sm font-medium text-brand-700 transition-colors hover:bg-brand-100"
          >
            Follow playback
          </button>
        </div>
      )}

      <div className="space-y-px p-2">
        {subSegments.map((sub, idx) => {
          const speakerName = resolveSpeakerName(sub);
          const colorIdx = getSpeakerColorIndex(speakerName);
          const isActive = currentTime >= sub.start_time && currentTime < sub.end_time;
          const prevSub = idx > 0 ? subSegments[idx - 1] : null;
          const showSpeaker =
            !prevSub || prevSub.parentId !== sub.parentId || prevSub.speaker_name !== sub.speaker_name;

          return (
            <div
              key={sub.id}
              id={`sidebar-seg-${sub.id}`}
              onClick={() => onSeek(sub.start_time)}
              className={cn(
                "cursor-pointer rounded-lg px-2.5 py-1.5 transition-colors",
                isActive ? "bg-brand-50" : "hover:bg-zinc-50",
                showSpeaker && idx > 0 && "mt-2",
              )}
            >
              {showSpeaker && (
                <div className="mb-0.5 flex items-center gap-2">
                  <span className={cn("h-2 w-2 shrink-0 rounded-full", SPEAKER_COLORS[colorIdx])} />
                  <span className="truncate text-xs font-medium text-zinc-700">{speakerName}</span>
                  <span className="ml-auto shrink-0 text-xs tabular-nums text-zinc-400">
                    {formatTimestamp(sub.start_time)}
                  </span>
                </div>
              )}
              <p
                className={cn(
                  "pl-4 text-sm leading-relaxed",
                  isActive ? "text-zinc-900" : "text-zinc-600",
                )}
              >
                {sub.text_content}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
