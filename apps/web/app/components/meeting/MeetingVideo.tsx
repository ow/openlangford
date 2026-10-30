import { Loader2, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { cn } from "../../lib/utils";
import { formatTimestamp } from "../../lib/timeline-utils";
import { getSpeakerColorIndex, SPEAKER_COLORS } from "../../lib/colors";
import { isUnidentifiedSpeaker } from "../../lib/speaker-labels";

/** The parts of useVideoPlayer() the player UI drives. */
export interface MeetingVideoControls {
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
}

export type PosterLabel = { title: string; date: string; eyebrow?: string | null };

interface MeetingVideoProps {
  videoPlayer: MeetingVideoControls;
  directVideoUrl?: string | null;
  directAudioUrl?: string | null;
  /** Still frame from the recording (meetings.meta.poster.url), shown until playback starts. */
  posterUrl?: string | null;
  /** Meeting name/date laid over the poster (HTML, not baked in) until playback starts. */
  posterLabel?: PosterLabel | null;
  /** The sentence being spoken now, for the caption overlay. */
  caption?: { speaker: string; text: string } | null;
  showCaption: boolean;
  setShowCaption: (show: boolean) => void;
  /** Recording length, used until the video reports its own. */
  totalDuration: number;
  onVideoError?: () => void;
  /**
   * "responsive": hover controls over the video on wide screens and a bar below
   * it on phones (the meeting page's wide player). "bar": always the bar below,
   * for narrow columns.
   */
  controls?: "responsive" | "bar";
  /** The stream couldn't be found: replace the spinner with this message and link. */
  unavailable?: { message: string; href?: string | null; linkLabel?: string } | null;
}

const RATES = [1, 1.5, 2];

/**
 * Meeting name and date over the poster frame, in the share card's style: a scrim
 * heavy at the bottom-left where the text sits, opening up toward the room.
 */
function PosterTitle({ label, compact }: { label?: PosterLabel | null; compact?: boolean }) {
  if (!label) return null;
  return (
    <>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(6,13,14,0.82)_0%,rgba(6,13,14,0.5)_45%,rgba(6,13,14,0.1)_100%),linear-gradient(0deg,rgba(6,13,14,0.75)_0%,rgba(6,13,14,0)_55%)]"
      />
      <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-1 bg-brand-400" />
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute bottom-0 left-0 max-w-[85%] p-3 text-left",
          compact ? "sm:p-5" : "sm:p-6 lg:p-8",
        )}
      >
        {label.eyebrow && (
          <span className="hidden text-xs font-bold tracking-[0.12em] text-brand-300 uppercase sm:block">
            {label.eyebrow}
          </span>
        )}
        <span
          className={cn(
            "mt-1 block text-base leading-tight font-extrabold tracking-tight text-balance text-white",
            compact ? "sm:text-2xl" : "sm:text-3xl lg:text-4xl",
          )}
        >
          {label.title}
        </span>
        <span className="mt-0.5 block text-xs font-medium text-white/80 sm:mt-1 sm:text-base">{label.date}</span>
      </span>
    </>
  );
}

/**
 * The meeting video: poster with title overlay, play button, captions and
 * controls, driven by useVideoPlayer(). Shared by the meeting page and the
 * timeline explorer. Render it inside a container that sets the width.
 */
export function MeetingVideo({
  videoPlayer,
  directVideoUrl,
  directAudioUrl,
  posterUrl,
  posterLabel,
  caption,
  showCaption,
  setShowCaption,
  totalDuration,
  onVideoError,
  controls = "responsive",
  unavailable,
}: MeetingVideoProps) {
  const responsive = controls === "responsive";
  const compact = !responsive;
  const cycleRate = () => {
    const nextIdx = (RATES.indexOf(videoPlayer.playbackRate) + 1) % RATES.length;
    videoPlayer.setPlaybackRate(RATES[nextIdx]);
  };
  const duration = videoPlayer.duration || totalDuration;
  const ready = videoPlayer.videoEnabled && !!directVideoUrl;

  return (
    <>
      <div
        className={cn(
          "group relative aspect-video bg-black",
          responsive && "lg:absolute lg:inset-0 lg:aspect-auto",
        )}
      >
        {/* Loading (or unavailable) state */}
        {!directVideoUrl && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-900">
            {posterUrl && (
              <>
                <img src={posterUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
                <PosterTitle label={posterLabel} compact={compact} />
              </>
            )}
            <div
              className={cn(
                "relative flex max-w-[80%] flex-col items-center gap-3 text-center",
                posterUrl && "rounded-xl bg-black/50 px-4 py-3 backdrop-blur-sm",
              )}
            >
              {unavailable ? (
                <>
                  <span className={cn("text-sm", posterUrl ? "text-zinc-100" : "text-zinc-300")}>
                    {unavailable.message}
                  </span>
                  {unavailable.href && (
                    <a
                      href={unavailable.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-full bg-surface px-3 py-1 text-sm font-medium text-zinc-900 hover:bg-zinc-100"
                    >
                      {unavailable.linkLabel || "Watch on the official site"}
                    </a>
                  )}
                </>
              ) : (
                <>
                  <Loader2 className={cn("h-6 w-6 animate-spin", posterUrl ? "text-zinc-300" : "text-zinc-500")} aria-hidden="true" />
                  <span className={cn("text-sm", posterUrl ? "text-zinc-200" : "text-zinc-400")}>Connecting to video…</span>
                </>
              )}
            </div>
          </div>
        )}

        <video
          key={directVideoUrl}
          ref={videoPlayer.videoRef}
          src={directVideoUrl || undefined}
          poster={posterUrl || undefined}
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
            aria-label={posterLabel ? `Play video: ${posterLabel.title}, ${posterLabel.date}` : "Play meeting video"}
            className={cn(
              "group/play absolute inset-0 z-10 flex items-center justify-center transition-colors",
              posterUrl && posterLabel ? "bg-transparent" : "bg-black/30 hover:bg-black/20",
            )}
            onClick={(e) => {
              e.stopPropagation();
              videoPlayer.setVideoEnabled(true);
              setTimeout(() => videoPlayer.togglePlay(), 100);
            }}
          >
            {posterUrl && <PosterTitle label={posterLabel} compact={compact} />}
            <span className="relative flex h-16 w-16 items-center justify-center rounded-full bg-surface/90 text-zinc-900 shadow-lg transition-transform group-hover/play:scale-105">
              <Play className="ml-1 h-7 w-7 fill-current" />
            </span>
          </button>
        )}

        {/* Loading spinner */}
        {videoPlayer.isLoading && videoPlayer.videoEnabled && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
            <div className="rounded-full bg-black/50 p-3 backdrop-blur-sm">
              <Loader2 className="h-7 w-7 animate-spin text-white" />
            </div>
          </div>
        )}

        {/* Captions */}
        {showCaption && caption && videoPlayer.videoEnabled && (
          <div
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center p-2",
              responsive && "lg:bottom-16 lg:p-4",
            )}
          >
            <div
              className={cn(
                "max-w-2xl rounded-lg bg-black/75 px-3 py-1.5 text-center backdrop-blur-sm",
                responsive && "lg:px-5 lg:py-2.5",
              )}
            >
              <div className="mb-0.5 flex items-center justify-center gap-1.5">
                <span
                  className={cn("h-1.5 w-1.5 shrink-0 rounded-full", SPEAKER_COLORS[getSpeakerColorIndex(caption.speaker)])}
                />
                <span className={cn("text-xs font-medium text-white/70", isUnidentifiedSpeaker(caption.speaker) && "italic text-white/50")}>
                  {caption.speaker}
                </span>
              </div>
              <p className={cn("text-xs leading-snug text-white sm:text-sm", responsive && "lg:text-base")}>
                {caption.text}
              </p>
            </div>
          </div>
        )}

        {/* Hover controls (wide layouts) */}
        {responsive && ready && (
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
                  {formatTimestamp(videoPlayer.currentTime)} / {formatTimestamp(duration)}
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

      {/* Control bar below the video (phones, or always in "bar" mode) */}
      {ready && (
        <div className={cn("bg-zinc-900 px-3 pb-2 pt-1 text-white", responsive && "lg:hidden")}>
          {duration > 0 && (
            <input
              type="range"
              min={0}
              max={duration}
              step={1}
              value={Math.min(videoPlayer.currentTime, duration)}
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
                {formatTimestamp(videoPlayer.currentTime)} / {formatTimestamp(duration)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <CaptionButton on={showCaption} onClick={() => setShowCaption(!showCaption)} />
              <RateButton rate={videoPlayer.playbackRate} onClick={cycleRate} />
            </div>
          </div>
        </div>
      )}
    </>
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
