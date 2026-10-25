import { useState } from "react";
import { Link } from "react-router";
import { cn } from "../../lib/utils";
import { writtenLetters, writtenSources, type WrittenParticipation } from "../../lib/written";

export type ParticipationSpeaker = { who: string; position: string; point: string; topic: string };
export type Participation = { overview?: string; speakers?: ParticipationSpeaker[] };

const POSITION_LABEL: Record<string, string> = {
  supports: "Supports",
  opposes: "Opposes",
  concerned: "Concerned",
  asks: "Asks",
  mixed: "Mixed",
};

const POSITION_TONE: Record<string, string> = {
  supports: "text-emerald-700",
  opposes: "text-red-700",
  concerned: "text-amber-700",
};

const STOP = new Set(["the", "and", "for", "with", "from", "bylaw", "city", "langford", "plan", "road", "avenue"]);
const words = (t: string) =>
  new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)));

/** Speakers relevant to a matter, by overlap between their topic and the matter's title/summary. */
export function speakersAbout(p: Participation | undefined, about: string): ParticipationSpeaker[] {
  const target = words(about);
  return (p?.speakers || []).filter((s) => [...words(`${s.topic} ${s.point}`)].some((w) => target.has(w)));
}

/** Public comment, one line per speaker (from the meeting transcript). */
export function ParticipationList({
  participation,
  speakers,
  note,
  className,
}: {
  participation?: Participation;
  speakers?: ParticipationSpeaker[];
  /** Short aside per person, e.g. "also wrote in". */
  note?: (who: string) => string | null;
  className?: string;
}) {
  const list = speakers ?? participation?.speakers ?? [];
  if (!list.length) return null;
  return (
    <ul className={cn("space-y-2", className)}>
      {list.map((s, i) => (
        <li key={i} className="text-sm leading-relaxed text-zinc-700">
          <span className="font-medium text-zinc-900">{s.who}</span>
          {POSITION_LABEL[s.position] && (
            <span className={cn("ml-1.5 text-xs font-medium", POSITION_TONE[s.position] || "text-zinc-500")}>
              {POSITION_LABEL[s.position]}
            </span>
          )}
          <span className="text-zinc-400"> · {s.topic}</span>
          {note?.(s.who) && <span className="text-zinc-400"> · {note(s.who)}</span>}
          <br />
          {s.point}
        </li>
      ))}
    </ul>
  );
}

const TALLY_LABEL: Record<string, string> = {
  opposes: "opposed",
  supports: "in support",
  concerned: "concerned",
  mixed: "mixed",
  asks: "questions",
  other: "other",
};

/** "8 opposed · 3 mixed · 1 in support", largest first. */
export function positionTally(list: { position: string }[]) {
  const counts = new Map<string, number>();
  for (const { position } of list) counts.set(position, (counts.get(position) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([position, n]) => `${n} ${TALLY_LABEL[position] ?? position}`)
    .join(" · ");
}

/** Letters and emails residents sent in, from the agenda package. */
export function WrittenSubmissions({
  written,
  documentHref,
  note,
  limit = 4,
  className,
}: {
  written?: WrittenParticipation;
  documentHref?: (documentId: number) => string;
  note?: (who: string) => string | null;
  limit?: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const letters = writtenLetters(written);
  if (!letters.length) return null;
  const shown = open ? letters : letters.slice(0, limit);
  const sources = documentHref ? writtenSources(written) : [];
  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-xs tabular-nums text-zinc-500">{positionTally(letters)}</p>
      <ParticipationList speakers={shown as ParticipationSpeaker[]} note={note} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {letters.length > limit && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="font-medium text-brand-700 hover:underline"
          >
            {open ? "Show fewer" : `Show all ${letters.length} letters`}
          </button>
        )}
        {sources.map((source, i) => (
          <Link
            key={source.documentId}
            to={documentHref!(source.documentId)}
            title={source.title}
            className="font-medium text-zinc-500 hover:text-brand-700 hover:underline"
          >
            {sources.length === 1 ? "Read the letters" : `Read the letters (${i + 1})`}
          </Link>
        ))}
      </div>
    </div>
  );
}
