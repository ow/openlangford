import { useEffect, useState } from "react";

export type MeetingMedia = {
  directVideoUrl: string | null;
  directAudioUrl: string | null;
  /** "loading" until /api/vimeo-url answers; "unavailable" when no playable stream was found. */
  status: "none" | "loading" | "ready" | "unavailable";
};

/**
 * Resolves a meeting's published video page (eSCRIBE/ISI player, or Vimeo for
 * older forks) to a direct media URL the <video> element can play, via the same
 * /api/vimeo-url endpoint the meeting page uses. Fetched client-side so it never
 * blocks the page.
 */
export function useMeetingMedia(videoUrl: string | null | undefined, meetingId: number): MeetingMedia {
  const [media, setMedia] = useState<MeetingMedia>({
    directVideoUrl: null,
    directAudioUrl: null,
    status: videoUrl ? "loading" : "none",
  });

  useEffect(() => {
    if (!videoUrl) {
      setMedia({ directVideoUrl: null, directAudioUrl: null, status: "none" });
      return;
    }
    let cancelled = false;
    setMedia({ directVideoUrl: null, directAudioUrl: null, status: "loading" });
    const params = new URLSearchParams({ video_url: videoUrl, meeting_id: String(meetingId) });
    fetch(`/api/vimeo-url?${params}`)
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
  }, [videoUrl, meetingId]);

  return media;
}
