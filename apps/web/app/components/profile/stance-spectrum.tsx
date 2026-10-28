/**
 * StanceSpectrum — visual indicator showing where a councillor falls
 * on a supports-to-opposes scale for a given topic.
 *
 * Props:
 *   score: number from -1.0 (strongly opposes) to 1.0 (strongly supports)
 *   position: 'supports' | 'opposes' | 'mixed' | 'neutral'
 *
 * Visual: horizontal gradient bar from red (opposes) through gray (neutral) to green (supports)
 * with a positioned marker at the score location and a label below.
 *
 * Used by both the profile page (Plan 03) and comparison page (Plan 04).
 */

interface StanceSpectrumProps {
  score: number;
  position: "supports" | "opposes" | "mixed" | "neutral";
}

const POSITION_LABELS: Record<StanceSpectrumProps["position"], string> = {
  supports: "Supports",
  opposes: "Opposes",
  mixed: "Mixed",
  neutral: "Neutral",
};

const POSITION_MARKER_COLORS: Record<StanceSpectrumProps["position"], string> = {
  supports: "bg-emerald-600 border-surface",
  opposes: "bg-red-600 border-surface",
  mixed: "bg-amber-500 border-surface",
  neutral: "bg-zinc-500 border-surface",
};

export function StanceSpectrum({ score, position }: StanceSpectrumProps) {
  // Clamp score to [-1, 1] and convert to percentage [0, 100]
  const clampedScore = Math.max(-1, Math.min(1, score));
  const percentage = ((clampedScore + 1) / 2) * 100;

  return (
    <div className="w-full">
      {/* Gradient bar with marker */}
      <div className="relative h-2 rounded-full bg-gradient-to-r from-red-300 via-zinc-200 to-emerald-300">
        {/* Marker */}
        <div
          className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-4 w-4 rounded-full border-2 shadow ring-1 ring-zinc-300 ${POSITION_MARKER_COLORS[position]}`}
          style={{ left: `${percentage}%` }}
          role="img"
          aria-label={`Position: ${POSITION_LABELS[position]} (score: ${clampedScore.toFixed(1)})`}
        />
      </div>

      {/* Labels */}
      <div className="mt-1.5 flex items-center justify-between text-xs text-zinc-500">
        <span>Opposes</span>
        <span className="font-medium text-zinc-800">
          {POSITION_LABELS[position]}
        </span>
        <span>Supports</span>
      </div>
    </div>
  );
}
