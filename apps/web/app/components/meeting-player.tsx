import { useState, useEffect, useRef, useMemo, forwardRef, useImperativeHandle } from "react";
import Player from "@vimeo/player";
import { ChevronDown } from "lucide-react";
import { cn } from "../lib/utils";
import type { AgendaItem } from "../lib/types";
import { displayTitle } from "../lib/display-text";

interface MeetingPlayerProps {
  videoUrl: string;
  agendaItems: AgendaItem[];
  onTimeUpdate?: (seconds: number) => void;
}

export interface MeetingPlayerHandle {
  seekTo: (seconds: number) => void;
}

export const MeetingPlayer = forwardRef<MeetingPlayerHandle, MeetingPlayerProps>(
  ({ videoUrl, agendaItems, onTimeUpdate }, ref) => {
    const [currentTime, setCurrentTime] = useState(0);
    const [player, setPlayer] = useState<Player | null>(null);
    const [isExpanded, setIsExpanded] = useState(true);
    const containerRef = useRef<HTMLDivElement>(null);

    useImperativeHandle(ref, () => ({
      seekTo: (seconds: number) => {
        if (player) {
          player.setCurrentTime(seconds);
          player.play();
        }
      },
    }));

        useEffect(() => {
          if (!containerRef.current) return;
    
          const vimeoPlayer = new Player(containerRef.current, {
            url: videoUrl as any,
            responsive: true,
            autoplay: false,
          });
    
          vimeoPlayer.on("timeupdate", (data) => {
            setCurrentTime(data.seconds);
            if (onTimeUpdate) onTimeUpdate(data.seconds);
          });
    
          setPlayer(vimeoPlayer);
    
          return () => {
            vimeoPlayer.destroy();
          };
        }, [videoUrl]);
    
        const activeItem = useMemo(() => {
          return agendaItems.find(item => 
            item.discussion_start_time !== null && 
            item.discussion_start_time !== undefined &&
            item.discussion_end_time !== null && 
            item.discussion_end_time !== undefined &&
            currentTime >= item.discussion_start_time && 
            currentTime < item.discussion_end_time
          );
        }, [currentTime, agendaItems]);
    const order = (activeItem?.item_order || "").trim().replace(/^[\s(.)]+|[\s(.)]+$/g, "");

    return (
      <div className="space-y-3">
        {/* Video Container */}
        <div className="aspect-video overflow-hidden rounded-2xl bg-black shadow-sm">
          <div ref={containerRef} className="h-full w-full" />
        </div>

        {/* Now discussing */}
        <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-surface shadow-sm">
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            aria-expanded={isExpanded}
            className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-zinc-50"
          >
            <span className="text-sm font-medium text-zinc-700">Now discussing</span>
            <ChevronDown
              className={cn("h-4 w-4 text-zinc-400 transition-transform", isExpanded && "rotate-180")}
              aria-hidden="true"
            />
          </button>

          {isExpanded && (
            <div className="border-t border-zinc-100 px-4 py-3">
              {activeItem ? (
                <div className="flex items-start gap-3">
                  {order && (
                    <span className="w-8 shrink-0 pt-px text-xs tabular-nums text-zinc-400">{order}</span>
                  )}
                  <div className="min-w-0 space-y-0.5">
                    <h4 className="text-sm font-medium leading-snug text-zinc-900">
                      {displayTitle(activeItem.title)}
                    </h4>
                    {activeItem.category && (
                      <p className="text-xs text-zinc-500">{activeItem.category}</p>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-zinc-500">
                  No agenda item is linked to this point in the video.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    );
  },
);
