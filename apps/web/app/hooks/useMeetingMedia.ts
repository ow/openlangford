import { useCallback, useEffect, useRef, useState } from "react";
import { selectVideoProvider, type VideoProviderInfo } from "../services/video/catalog";

export type MeetingMedia = {
  directVideoUrl: string | null;
  directAudioUrl: string | null;
  /** "loading" until /api/video-source answers; "unavailable" when no playable stream was found. */
  status: "none" | "loading" | "ready" | "unavailable";
  /** The provider that owns the meeting's video URL (label, deep links), detected from the URL. */
  provider: VideoProviderInfo | null;
  /**
   * Call when the <video> element fails to play the stream. The first failure
   * reports it (so the server drops its cached stream) and fetches a fresh one;
   * a second failure marks the video unavailable.
   */
  reportFailure: () => void;
};

type Resolved = Pick<MeetingMedia, "directVideoUrl" | "directAudioUrl" | "status">;

/**
 * Resolves a meeting's published video page (eSCRIBE/ISI player, or Vimeo) to a
 * direct media URL the <video> element can play, via /api/video-source and the
 * municipality's video provider. Fetched client-side so it never blocks the page.
 */
export function useMeetingMedia(videoUrl: string | null | undefined, meetingId: number): MeetingMedia {
  const [media, setMedia] = useState<Resolved>({
    directVideoUrl: null,
    directAudioUrl: null,
    status: videoUrl ? "loading" : "none",
  });
  const [attempt, setAttempt] = useState(0);
  const failures = useRef(0);
  // The <video> element and the HLS player can both report the same failure; count it once per stream fetch.
  const failedAttempt = useRef<number | null>(null);

  useEffect(() => {
    failures.current = 0;
    failedAttempt.current = null;
    setAttempt(0);
  }, [videoUrl, meetingId]);

  useEffect(() => {
    if (!videoUrl) {
      setMedia({ directVideoUrl: null, directAudioUrl: null, status: "none" });
      return;
    }
    let cancelled = false;
    setMedia({ directVideoUrl: null, directAudioUrl: null, status: "loading" });
    const params = new URLSearchParams({ video_url: videoUrl, meeting_id: String(meetingId) });
    fetch(`/api/video-source?${params}`)
      .then((res) => res.json())
      .then((data: any) => {
        if (cancelled) return;
        const directVideoUrl = data?.direct_url || null;
        setMedia({
          directVideoUrl,
          directAudioUrl: data?.direct_audio_url || null,
          status: directVideoUrl ? "ready" : "unavailable",
        });
      })
      .catch(() => {
        if (!cancelled) setMedia({ directVideoUrl: null, directAudioUrl: null, status: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [videoUrl, meetingId, attempt]);

  const reportFailure = useCallback(() => {
    if (failedAttempt.current === attempt) return;
    failedAttempt.current = attempt;
    failures.current += 1;
    if (failures.current > 1) {
      setMedia({ directVideoUrl: null, directAudioUrl: null, status: "unavailable" });
      return;
    }
    const body = new FormData();
    body.append("meetingId", String(meetingId));
    fetch("/api/report-video-failure", { method: "POST", body })
      .catch(() => {})
      .finally(() => setAttempt((n) => n + 1));
  }, [meetingId, attempt]);

  return { ...media, provider: selectVideoProvider(videoUrl), reportFailure };
}
