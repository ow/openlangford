import type { ReactNode } from "react";
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

/** The stages a step can be given by hand (agenda_items.meta.staff_stage, set by the fix agent's set_stage when the
 * wording-based guess below is wrong), with the plain-language meaning residents see. */
export const STAGE_LABELS = {
  rescinded_adoption: "Council cancelled the bylaw's adoption and its readings.",
  rescinded_reading: "Council cancelled an earlier reading of the bylaw.",
  rescinded: "Council cancelled an earlier decision.",
  adopted: "Final approval.",
  second_third: "Council approved the content and final wording. Adoption is the last step.",
  third: "Council approved the final wording. Adoption is the last step.",
  public_hearing: "Residents could speak or write to council about the proposal.",
  second: "Council approved the bylaw's content in principle.",
  first: "Introduced to council. A bylaw needs several readings before it becomes law.",
} as const;
export type StageChoice = keyof typeof STAGE_LABELS | "none";

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
  const motions: Motion[] = item.motions || [];
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
}: {
  item: any;
  headline?: string;
  /** A stage set by hand for this step (agenda_items.meta.staff_stage), over the guess from its wording. */
  chosenStage?: string | null;
  docs: any[];
  layoutImage?: { url: string; width?: number; height?: number } | null;
  participation?: any;
  written?: any;
  notes?: { speaker: (who: string) => string | null; letter: (who: string) => string | null };
}) {
  const motions: Motion[] = item.motions || [];
  const letterCount = writtenLetters(written).length;
  const hasParticipation = Boolean(participation?.speakers?.length || letterCount);
  const procedural = isProceduralStep(item, { hasParticipation, hasImage: Boolean(layoutImage), headline, stage: chosenStage });
  const stage = stageExplanation([headline, item.title, ...motions.map((m) => m.text_content)], { committee: isCommitteeItem(item), chosen: chosenStage });
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
      <div className="py-1">
        {meetingLine}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="font-semibold leading-snug text-zinc-900">{title}</h3>
          {decisions[0]?.o.label && outcomeMark(decisions[0].o)}
        </div>
        {stage && <p className="mt-0.5 text-sm text-zinc-600">{stage}</p>}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-zinc-200 bg-surface p-5 shadow-sm sm:p-6">
      {meetingLine}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="text-lg font-semibold leading-snug text-zinc-900">{title}</h3>
        {single && outcomeMark(single)}
      </div>
      {item.plain_english_summary && <p className="mt-1.5 text-sm leading-relaxed text-zinc-600">{item.plain_english_summary}</p>}
      {stage && !item.plain_english_summary && <p className="mt-1.5 text-sm text-zinc-600">{stage}</p>}

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
                <span className="font-medium">Decision:</span> {m.plain_english_summary || displayTitle(m.text_content || "")}
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
