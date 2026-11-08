/**
 * A YouTube video, embedded with YouTube's own player (the no-cookie host, lazy-loaded so it only loads when it scrolls
 * near). ``id`` comes from ``youtubeId`` (lib/sources.ts), so it is always eleven safe characters.
 */
export function VideoEmbed({ id, title, className = "" }: { id: string; title: string; className?: string }) {
  return (
    <div className={`aspect-video w-full overflow-hidden rounded-xl border border-zinc-200 bg-black ${className}`}>
      <iframe
        src={`https://www.youtube-nocookie.com/embed/${id}?rel=0`}
        title={title}
        loading="lazy"
        allow="encrypted-media; picture-in-picture; fullscreen"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        className="h-full w-full"
      />
    </div>
  );
}
