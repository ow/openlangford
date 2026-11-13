import type { ReactNode } from "react";
import { TermText } from "../term";
import { completeVoteCounts, videoDissent } from "../../lib/vote-coverage";
import { VideoDissentNote } from "../video-dissent-note";
import { Link } from "react-router";
import { ArrowUpRight } from "lucide-react";
import { Badge } from "../ui/badge";
import { displayTitle } from "../../lib/display-text";
import { isTranscribedMotion, TRANSCRIBED_NOTE, TRANSCRIBED_TITLE } from "../../lib/motion-utils";
import { formatDate, cn } from "../../lib/utils";
import { ParticipationList, WrittenSubmissions } from "../meeting/participation-list";
import { writtenLetters } from "../../lib/written";
import { documentPath, meetingPath, type SlugRef } from "../../lib/paths";
import { FADED_CARD } from "../timeline/chrome";

import { STAGE_LABELS, type StageKey } from "../../lib/glossary";

export { STAGE_LABELS };
export type StageChoice = StageKey | "none";

/** Plain-language meaning of a bylaw stage, for residents who don't know what "second reading" means. */
const STAGES: { test: RegExp; label: string }[] = [
  // Rescinding cancels an earlier decision; the record rarely says why, so the label doesn't guess.
  // Rescinding an adoption undoes the bylaw itself, not just a reading.
  { test: /rescind\w*.{0,60}\badoption\b|\badoption\b.{0,40}rescind/i, label: STAGE_LABELS.rescinded_adoption },
  { test: /rescind\w*.{0,60}\b(reading|readings)\b|\b(reading|readings)\b.{0,40}rescind/i, label: STAGE_LABELS.rescinded_reading },
  { test: /rescind/i, label: STAGE_LABELS.rescinded },
  { test: /\badopt(ed|ion)?\b|final adoption/i, label: STAGE_LABELS.adopted },
  { test: /second (and|&) third reading|second, third|2nd (and|&) 3rd/i, label: STAGE_LABELS.second_third },
  { test: /third reading|3rd reading/i, label: STAGE_LABELS.third },
  { test: /public hearing/i, label: STAGE_LABELS.public_hearing },
  { test: /second reading|2nd reading/i, label: STAGE_LABELS.second },
  { test: /first reading|1st reading/i, label: STAGE_LABELS.first },
];

const ADOPTION = STAGES.find((s) => s.label === STAGE_LABELS.adopted)!.test;

/** Words that make an "adopt" a recommendation or an instruction, not the adoption itself. */
const NOT_ADOPTING = /\brecommend|\bdirect(s|ed)? staff|\bstaff (were |was )?directed|\bprepare\b|proceed with consideration|\brefer(red)? /i;

/** A condition set for a later step ("prior to Bylaw Adoption", "before the public hearing") names that step without
 * taking it, so it is left out before the stage is judged. */
const LATER_STEP = /\b(?:prior to|before|ahead of|in advance of|until)\s+(?:[\w'’-]+\s+){0,4}?(?:adoption|adopting|public hearing)\b/gi;

/** A step's plain-language stage. Only Council's own adoption is "final approval": a committee recommending that
 * Council adopt something, or Council directing staff to prepare a bylaw for adoption, is an earlier step. */
export function stageExplanation(texts: (string | null | undefined)[], { committee = false, chosen }: { committee?: boolean; chosen?: string | null } = {}): string | null {
  // A stage chosen by hand for this step wins over the guess from its wording.
  if (chosen === "none") return null;
  if (chosen && chosen in STAGE_LABELS) return STAGE_LABELS[chosen as keyof typeof STAGE_LABELS];
  const parts = (texts.filter(Boolean) as string[]).map((t) => t.replace(LATER_STEP, ""));
  const text = parts.join(" ");
  // Judged per text: a headline "Council adopts the policy" is final even beside a motion that also directs staff.
  const adopts = !committee && parts.some((t) => ADOPTION.test(t) && !NOT_ADOPTING.test(t));
  return STAGES.find((s) => s.label === STAGE_LABELS.adopted ? adopts : s.test.test(text))?.label ?? null;
}

/** A headline that already says the step was final ("…made final", "Council adopts…"), so "Final approval." beside it
 * would only repeat it. The other stage lines teach a term (what a second reading is), so they stay. */
const SAYS_FINAL = /\badopt|\bmade final\b|\bfinal(ly)?\b|\bapproved\b/i;

const plain = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** What a step says under its title. The item's own summary when it has one that adds to the title; otherwise the
 * stage's plain-language line, unless that only repeats the title; otherwise nothing. */
export function stepNote({ stage, title, summary }: { stage: string | null; title: string; summary?: string | null }): { kind: "summary" | "stage"; text: string } | null {
  if (summary?.trim() && plain(summary) !== plain(title)) return { kind: "summary", text: summary };
  const stageText = stageLineFor(stage, title);
  return stageText ? { kind: "stage", text: stageText } : null;
}

/** The stage's line, or null when the title already says it. */
export function stageLineFor(stage: string | null, title: string): string | null {
  if (!stage) return null;
  return stage === STAGE_LABELS.adopted && SAYS_FINAL.test(title) ? null : stage;
}

/** Whether an item's meeting is a committee's rather than Council's. */
export function isCommitteeItem(item: any): boolean {
  const meeting = item?.meetings || {};
  return /committee|commission|board/i.test(`${meeting.organizations?.name || ""} ${meeting.type || ""}`);
}

type Vote = { id: number; vote: string; person?: { name?: string | null } | null };
type Motion = {
  id: number;
  disposition?: string | null;
  text_content?: string | null;
  plain_english_summary?: string | null;
  result?: string | null;
  mover?: string | null;
  seconder?: string | null;
  votes?: Vote[] | null;
  meta?: any;
};

function tally(motion: Motion) {
  const votes = motion.votes || [];
  const no = votes.filter((v) => v.vote === "No");
  // A count ("5–2") only when the whole vote is known; minutes often name just the people opposed, and counting
  // those rows alone read as "Carried 0–2".
  const complete = completeVoteCounts(motion as any);
  return { yes: complete?.yes ?? 0, no: complete?.no ?? no.length, against: no.map((v) => v.person?.name).filter(Boolean) as string[],
    counted: !!complete };
}

function outcome(motion: Motion) {
  // A carried motion to table or defer leaves the item unsettled: show that, not "Passed".
  // Minutes say "table" for putting an item off; readers take "tabled" to mean presented (docs/writing-style.md).
  const setAside = /defer|tabled|postpone/i.test(motion.disposition || "") ? "Postponed"
    : /refer/i.test(motion.disposition || "") ? displayTitle(motion.disposition!) : null;
  const passed = !setAside && /carried|passed|approved|adopted/i.test(motion.result || "");
  const failed = /defeated|failed|lost/i.test(motion.result || "");
  const t = tally(motion);
  const label = setAside ?? (passed ? "Passed" : failed ? "Defeated" : motion.result ? displayTitle(motion.result) : null);
  return {
    label,
    variant: passed ? "success" as const : failed ? "danger" as const : setAside || /defer|tabled|postpone|refer/i.test(motion.result || "") ? "warning" as const : "muted" as const,
    count: t.counted ? `${t.yes}–${t.no}` : null,
    against: t.against,
    // Not unanimous when the video shows a vote against that the minutes don't record.
    unanimous: (t.counted ? t.no === 0 : t.against.length === 0) && !videoDissent(motion).length,
  };
}

export function isProceduralStep(item: any, extra: { hasParticipation: boolean; hasImage: boolean; headline?: string; stage?: string | null }) {
  // A motion the minutes then amended ("the main motion as amended", motions.meta.amended_by) is one decision: the
  // timeline shows the amended one only, while it is under the same item.
  const all: Motion[] = item.motions || [];
  const motions = all.filter((m: any) => !(m.meta?.amended_by && all.some((x) => x.id === m.meta.amended_by)));
  return (
    Boolean(stageExplanation([extra.headline, item.title, ...motions.map((m) => m.text_content)], { committee: isCommitteeItem(item), chosen: extra.stage })) &&
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
  notes,
  chosenStage,
  termHints,
}: {
  item: any;
  headline?: string;
  /** The glossary terms this step may mark inline, keyed "item-<id>" for its summary and "motion-<id>" per decision
   * (from hintPlan over the whole timeline, so the page marks each term once). */
  termHints?: Map<string, ReadonlySet<string>>;
  /** A stage set by hand for this step (agenda_items.meta.staff_stage), over the guess from its wording. */
  chosenStage?: string | null;
  docs: any[];
  layoutImage?: { url: string; width?: number; height?: number } | null;
  participation?: any;
  written?: any;
  notes?: { speaker: (who: string) => string | null; letter: (who: string) => string | null };
}) {
  // A motion the minutes then amended ("the main motion as amended", motions.meta.amended_by) is one decision: the
  // timeline shows the amended one only, while it is under the same item.
  const all: Motion[] = item.motions || [];
  const motions = all.filter((m: any) => !(m.meta?.amended_by && all.some((x) => x.id === m.meta.amended_by)));
  const letterCount = writtenLetters(written).length;
  const hasParticipation = Boolean(participation?.speakers?.length || letterCount);
  const procedural = isProceduralStep(item, { hasParticipation, hasImage: Boolean(layoutImage), headline, stage: chosenStage });
  const stage = stageExplanation([headline, item.title, ...motions.map((m) => m.text_content)], { committee: isCommitteeItem(item), chosen: chosenStage });
  const title = headline || displayTitle(item.title);
  const note = stepNote({ stage, title, summary: item.plain_english_summary });
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
  // A badge like the topic's own status: "Adopted" for a final approval that passed.
  const outcomeMark = (o: ReturnType<typeof outcome>) => (
    <Badge variant={o.variant} className="shrink-0 tabular-nums">
      {isFinal && o.label === "Passed" ? "Adopted" : o.label}{o.count ? ` ${o.count}` : ""}
    </Badge>
  );
  // One decision: its outcome sits beside the step's title. Several: each decision line leads with its own.
  const single = decisions.length === 1 && decisions[0].o.label ? decisions[0].o : null;

  if (procedural) {
    return (
      <div className={FADED_CARD}>
        {meetingLine}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <h4 className="font-semibold leading-snug text-zinc-900">{title}</h4>
          {decisions[0]?.o.label && outcomeMark(decisions[0].o)}
        </div>
        {note && (
          <p className="mt-0.5 text-sm text-zinc-600">
            {note.kind === "summary" ? <TermText text={note.text} only={termHints?.get(`item-${item.id}`)} /> : note.text}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-zinc-200 bg-surface p-5 shadow-sm sm:p-6">
      {meetingLine}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="text-lg font-semibold leading-snug text-zinc-900">{title}</h4>
        {single && outcomeMark(single)}
      </div>
      {item.plain_english_summary && <p className="mt-1.5 text-sm leading-relaxed text-zinc-600"><TermText text={item.plain_english_summary} only={termHints?.get(`item-${item.id}`)} /></p>}
      {!item.plain_english_summary && stageLineFor(stage, title) && <p className="mt-1.5 text-sm text-zinc-600">{stageLineFor(stage, title)}</p>}

      {layoutImage && (
        <figure className="mt-4">
          <a href={layoutImage.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl border border-zinc-200 bg-surface">
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
          <ParticipationList participation={participation} note={notes?.speaker} />
        </div>
      )}

      {letterCount > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs font-semibold text-zinc-500">Written submissions ({letterCount})</p>
          <WrittenSubmissions
            written={written}
            documentHref={(documentId) => documentPath({ id: item.meeting_id, slug: item.meetings?.slug }, documentId)}
            note={notes?.letter}
          />
        </div>
      )}

      {decisions.length > 0 && (
        <div className="mt-4 space-y-2 border-t border-zinc-100 pt-4">
          {decisions.map(({ m, o }) => (
            <div key={m.id} className="text-sm">
              <p className="text-zinc-800">
                {!single && o.label && <>{outcomeMark(o)}{" "}</>}
                <span className="font-medium">Decision:</span> <TermText text={m.plain_english_summary || displayTitle(m.text_content || "")} only={termHints?.get(`motion-${m.id}`)} />
              </p>
              {((o.label && o.against.length > 0) || isTranscribedMotion(m)) && (
                <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-zinc-500">
                  {o.label && o.against.length > 0 && <span>Against: {o.against.join(", ")}</span>}
                  {isTranscribedMotion(m) && (
                    <span title={TRANSCRIBED_TITLE}>{o.label && o.against.length > 0 ? "· " : ""}{TRANSCRIBED_NOTE}</span>
                  )}
                </p>
              )}
              <VideoDissentNote motion={m} className="mt-1" />
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
