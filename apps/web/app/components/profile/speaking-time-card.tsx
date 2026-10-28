import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { cn } from "../../lib/utils";
import { TOPIC_COLORS, type TopicName } from "../../lib/topic-utils";

// ── Types ──

interface SpeakingTimeCardProps {
  totalSeconds: number;
  meetingCount: number;
  segmentCount: number;
  trendData: { meeting_date: string; seconds_spoken: number }[];
  topicBreakdown: { topic: string; total_seconds: number }[];
  rank?: number;
  totalCouncillors?: number;
  fixedPeriodLabel?: string;
}

// ── Helpers ──

function formatHours(seconds: number): string {
  return (seconds / 3600).toFixed(1);
}

function ordinalSuffix(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ── Time Range Selector ──

const TIME_RANGES = [
  { value: "12m", label: "Last 12 months" },
  { value: "term", label: "Current term" },
  { value: "all", label: "All time" },
] as const;

function TimeRangeSelector({ current }: { current: string }) {
  const [searchParams] = useSearchParams();

  return (
    <div className="flex gap-0.5 rounded-lg bg-zinc-100 p-0.5">
      {TIME_RANGES.map((range) => {
        const params = new URLSearchParams(searchParams);
        if (range.value === "all") {
          params.delete("timeRange");
        } else {
          params.set("timeRange", range.value);
        }
        const isActive = current === range.value;
        return (
          <Link
            key={range.value}
            to={`?${params.toString()}`}
            preventScrollReset
            className={cn(
              "whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              isActive
                ? "bg-surface text-zinc-900 shadow-sm"
                : "text-zinc-500 hover:text-zinc-700"
            )}
          >
            {range.label}
          </Link>
        );
      })}
    </div>
  );
}

// ── Sparkline SVG ──

function Sparkline({
  data,
  councilAvgSeconds,
}: {
  data: { meeting_date: string; seconds_spoken: number }[];
  councilAvgSeconds: number;
}) {
  const width = 280;
  const height = 80;
  const padding = { top: 8, right: 8, bottom: 8, left: 8 };

  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  if (data.length < 2) {
    return (
      <div className="flex h-20 items-center justify-center text-sm text-zinc-500">
        Not enough meetings to show a trend
      </div>
    );
  }

  const maxVal = Math.max(...data.map((d) => d.seconds_spoken), councilAvgSeconds);
  const safeMax = maxVal || 1;

  const points = data.map((d, i) => {
    const x = padding.left + (i / (data.length - 1)) * chartW;
    const y = padding.top + chartH - (d.seconds_spoken / safeMax) * chartH;
    return { x, y, ...d };
  });

  const polyline = points.map((p) => `${p.x},${p.y}`).join(" ");

  // Council average dashed line
  const avgY = padding.top + chartH - (councilAvgSeconds / safeMax) * chartH;

  return (
    <figure>
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-20" preserveAspectRatio="none">
      {/* Council average line */}
      <line
        x1={padding.left}
        y1={avgY}
        x2={width - padding.right}
        y2={avgY}
        stroke="currentColor"
        strokeWidth="0.5"
        strokeDasharray="4 3"
        vectorEffect="non-scaling-stroke"
        className="text-zinc-300"
      />

      {/* Trend area fill */}
      <polygon
        points={`${points[0].x},${padding.top + chartH} ${polyline} ${points[points.length - 1].x},${padding.top + chartH}`}
        className="fill-brand-500/10"
      />

      {/* Trend line */}
      <polyline
        points={polyline}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        className="text-brand-500"
      />

      {/* Data point dots */}
      {points.map((p, i) => (
        <g key={i}>
          <circle
            cx={p.x}
            cy={p.y}
            r="2"
            className="fill-brand-500"
          />
          {/* Invisible larger hit target for hover */}
          <circle cx={p.x} cy={p.y} r="8" fill="transparent">
            <title>
              {new Date(p.meeting_date + "T00:00:00").toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}: {Math.round(p.seconds_spoken / 60)} min
            </title>
          </circle>
        </g>
      ))}
    </svg>
    <figcaption className="mt-1 text-xs text-zinc-500">
      Speaking time per meeting · dashed line is their average ({Math.round(councilAvgSeconds / 60)} min)
    </figcaption>
    </figure>
  );
}

// ── Topic Breakdown Bars ──

function TopicBreakdownBars({
  topics,
}: {
  topics: { topic: string; total_seconds: number }[];
}) {
  if (topics.length === 0) return null;

  const maxSeconds = Math.max(...topics.map((t) => t.total_seconds));

  return (
    <div className="space-y-3 border-t border-zinc-100 pt-4">
      <h4 className="text-sm font-medium text-zinc-700">Time by topic</h4>
      {topics.map((t) => {
        const topicName = t.topic as TopicName;
        const colors = TOPIC_COLORS[topicName] || "text-zinc-400 bg-zinc-50 border-zinc-200";
        const pct = maxSeconds > 0 ? (t.total_seconds / maxSeconds) * 100 : 0;
        const textColorClass = colors.split(" ")[0]; // extract text-* class

        return (
          <div key={t.topic} className="space-y-1">
            <div className="flex items-center justify-between text-sm">
              <span className="text-zinc-700">{t.topic}</span>
              <span className="tabular-nums text-zinc-500">
                {formatHours(t.total_seconds)}h
              </span>
            </div>
            <div className="w-full bg-zinc-100 rounded-full h-1.5 overflow-hidden">
              <div
                className={cn("h-full rounded-full opacity-70", textColorClass.replace("text-", "bg-"))}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Main Component ──

export function SpeakingTimeCard({
  totalSeconds,
  meetingCount,
  segmentCount,
  trendData,
  topicBreakdown,
  rank,
  totalCouncillors,
  fixedPeriodLabel,
}: SpeakingTimeCardProps) {
  const [searchParams] = useSearchParams();
  const timeRange = searchParams.get("timeRange") || "all";

  // Compute council average seconds per meeting from trend data
  const councilAvgSeconds = useMemo(() => {
    if (!trendData.length || !meetingCount) return 0;
    return totalSeconds / meetingCount;
  }, [totalSeconds, meetingCount, trendData.length]);

  return (
    <section className="space-y-4 rounded-2xl border border-zinc-200 bg-surface p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-zinc-900">Recorded speech</h3>
        {fixedPeriodLabel ? <span className="text-sm text-zinc-500">{fixedPeriodLabel}</span> : <TimeRangeSelector current={timeRange} />}
      </div>

      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
        <div>
          <span className="text-3xl font-bold tabular-nums tracking-tight text-zinc-900">
            {formatHours(totalSeconds)}
          </span>
          <span className="ml-1 text-sm text-zinc-500">hours</span>
          <span className="ml-2 text-sm text-zinc-500 tabular-nums">
            across {meetingCount} meeting{meetingCount !== 1 ? "s" : ""}
          </span>
        </div>
        {rank != null && totalCouncillors != null && (
          <p className="text-sm text-zinc-500">
            <span className="font-semibold text-brand-700">{ordinalSuffix(rank)}</span> of {totalCouncillors} identified speakers
          </p>
        )}
      </div>

      {/* Sparkline trend chart */}
      <Sparkline data={trendData} councilAvgSeconds={councilAvgSeconds} />

      {/* Topic breakdown */}
      <TopicBreakdownBars topics={topicBreakdown} />
      <p className="text-xs leading-relaxed text-zinc-500">Only identified speech in available transcripts is counted. Missing transcripts and unidentified speakers are excluded, so this is not a complete service total.</p>
    </section>
  );
}
