import type { ReactNode } from "react";
import { Link } from "react-router";
import { ArrowUpRight } from "lucide-react";
import { Badge } from "../ui/badge";
import { displayTitle } from "../../lib/display-text";
import { formatDate, cn } from "../../lib/utils";
import { ParticipationList, WrittenSubmissions } from "../meeting/participation-list";
import { writtenLetters } from "../../lib/written";
import { documentPath, meetingPath, type SlugRef } from "../../lib/paths";

/** Plain-language meaning of a bylaw stage, for residents who don't know what "second reading" means. */
const STAGES: { test: RegExp; label: string }[] = [
  { test: /rescind/i, label: "An earlier step was redone to correct the bylaw." },
  { test: /\badopt(ed|ion)?\b|final adoption/i, label: "Final approval." },
  { test: /second (and|&) third reading|second, third|2nd (and|&) 3rd/i, label: "Council approved the content and final wording. Adoption is the last step." },
  { test: /third reading|3rd reading/i, label: "Council approved the final wording. Adoption is the last step." },
  { test: /public hearing/i, label: "Residents could speak or write to council about the proposal." },
  { test: /second reading|2nd reading/i, label: "Council approved the bylaw's content in principle." },
  { test: /first reading|1st reading/i, label: "Introduced to council. A bylaw needs several readings before it becomes law." },
];

export function stageExplanation(...texts: (string | null | undefined)[]): string | null {
  const text = texts.filter(Boolean).join(" ");
  return STAGES.find((s) => s.test.test(text))?.label ?? null;
}

type Vote = { id: number; vote: string; person?: { name?: string | null } | null };
type Motion = {
  id: number;
  text_content?: string | null;
  plain_english_summary?: string | null;
  result?: string | null;
  mover?: string | null;
  seconder?: string | null;
  votes?: Vote[] | null;
};

function tally(motion: Motion) {
  const votes = motion.votes || [];
  const yes = votes.filter((v) => v.vote === "Yes").length;
  const no = votes.filter((v) => v.vote === "No");
  return { yes, no: no.length, against: no.map((v) => v.person?.name).filter(Boolean) as string[], counted: votes.length > 0 };
}

function outcome(motion: Motion) {
  const passed = /carried|passed|approved|adopted/i.test(motion.result || "");
  const failed = /defeated|failed|lost/i.test(motion.result || "");
  const t = tally(motion);
  const label = passed ? "Passed" : failed ? "Defeated" : motion.result ? displayTitle(motion.result) : null;
  return {
    label,
    tone: passed ? "text-emerald-700" : failed ? "text-red-700" : "text-zinc-600",
    count: t.counted ? `${t.yes}–${t.no}` : null,
    against: t.against,
    unanimous: t.counted ? t.no === 0 : true,
  };
}

export function isProceduralStep(item: any, extra: { hasParticipation: boolean; hasImage: boolean; headline?: string }) {
  const motions: Motion[] = item.motions || [];
  return (
    Boolean(stageExplanation(extra.headline, item.title, ...motions.map((m) => m.text_content))) &&
    !item.debate_summary &&
    !extra.hasParticipation &&
    !extra.hasImage &&
    motions.every((m) => outcome(m).unanimous)
  );
}

function DocLinks({ docs, meeting }: { docs: any[]; meeting: SlugRef }) {
  if (!docs.length) return null;
  return (
    <ul className="space-y-1">
      {docs.map((doc) => (
        <li key={doc.id}>
          <Link to={documentPath(meeting, doc.id)} className="text-sm text-brand-700 hover:underline">
            {displayTitle(doc.title)}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function TimelineStep({
  item,
  headline,
  docs,
  layoutImage,
  participation,
  written,
}: {
  item: any;
  headline?: string;
  docs: any[];
  layoutImage?: { url: string; width?: number; height?: number } | null;
  participation?: any;
  written?: any;
}) {
  const motions: Motion[] = item.motions || [];
  const letterCount = writtenLetters(written).length;
  const hasParticipation = Boolean(participation?.speakers?.length || letterCount);
  const procedural = isProceduralStep(item, { hasParticipation, hasImage: Boolean(layoutImage), headline });
  const stage = stageExplanation(headline, item.title, ...motions.map((m) => m.text_content));
  const title = headline || displayTitle(item.title);
  const itemHref = meetingPath({ id: item.meeting_id, slug: item.meetings?.slug }, `#item-${item.id}`);
  const meetingLine = (
    <p className="flex items-center gap-1.5 text-xs text-zinc-500">
      <span className="tabular-nums">{formatDate(item.meetings?.meeting_date)}</span>
      {item.meetings?.organizations?.name && <span>· {item.meetings.organizations.name}</span>}
      <Link
        to={itemHref}
        title="Open this item in the meeting"
        aria-label="Open this item in the meeting"
        className="-m-1 rounded p-1 text-zinc-400 hover:text-brand-700"
      >
        <ArrowUpRight className="h-3.5 w-3.5" />
      </Link>
    </p>
  );
  const isFinal = /final approval/i.test(stage || "");
  const decisions = motions.map((m) => ({ m, o: outcome(m) }));
  const outcomeMark = (o: ReturnType<typeof outcome>) =>
    isFinal && o.label === "Passed" ? (
      <Badge variant="success">Adopted{o.count ? ` ${o.count}` : ""}</Badge>
    ) : (
      <span className={cn("shrink-0 text-xs font-medium tabular-nums", o.tone)}>
        {o.label}
        {o.count && ` ${o.count}`}
      </span>
    );

  if (procedural) {
    return (
      <div className="py-1">
        {meetingLine}
        <div className="mt-0.5 flex flex-wrap items-baseline justify-between gap-x-3">
          <h3 className="font-semibold leading-snug text-zinc-900">{title}</h3>
          {decisions[0]?.o.label && outcomeMark(decisions[0].o)}
        </div>
        {stage && <p className="mt-0.5 text-sm text-zinc-600">{stage}</p>}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm sm:p-6">
      {meetingLine}
      <h3 className="mt-1 text-lg font-semibold leading-snug text-zinc-900">{title}</h3>
      {item.plain_english_summary && <p className="mt-1.5 text-sm leading-relaxed text-zinc-600">{item.plain_english_summary}</p>}
      {stage && !item.plain_english_summary && <p className="mt-1.5 text-sm text-zinc-600">{stage}</p>}

      {layoutImage && (
        <figure className="mt-4">
          <a href={layoutImage.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl border border-zinc-200 bg-white">
            <img src={layoutImage.url} alt="Proposed layout" width={layoutImage.width} height={layoutImage.height} className="max-h-[360px] w-full object-contain" loading="lazy" />
          </a>
          <figcaption className="mt-1.5 text-xs text-zinc-500">Proposed layout</figcaption>
        </figure>
      )}

      {item.debate_summary && (
        <div className="mt-4">
          <p className="text-xs font-semibold text-zinc-500">Discussion</p>
          <p className="mt-1 text-sm leading-relaxed text-zinc-700">{item.debate_summary}</p>
        </div>
      )}

      {participation?.speakers?.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs font-semibold text-zinc-500">Who spoke</p>
          <ParticipationList participation={participation} />
        </div>
      )}

      {letterCount > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs font-semibold text-zinc-500">Written submissions ({letterCount})</p>
          <WrittenSubmissions
            written={written}
            documentHref={(documentId) => documentPath({ id: item.meeting_id, slug: item.meetings?.slug }, documentId)}
          />
        </div>
      )}

      {decisions.length > 0 && (
        <div className="mt-4 space-y-2 border-t border-zinc-100 pt-4">
          {decisions.map(({ m, o }) => (
            <div key={m.id} className="text-sm">
              <p className="text-zinc-800">
                <span className="font-medium">Decision:</span> {m.plain_english_summary || displayTitle(m.text_content || "")}
              </p>
              {o.label && (
                <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs">
                  {outcomeMark(o)}
                  {o.against.length > 0 && <span className="text-zinc-500">· Against: {o.against.join(", ")}</span>}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {docs.length > 0 && (
        <div className="mt-4">
          <p className="mb-1 text-xs font-semibold text-zinc-500">Documents</p>
          <DocLinks docs={docs} meeting={{ id: item.meeting_id, slug: item.meetings?.slug }} />
        </div>
      )}
    </div>
  );
}
