import type { AgendaItem } from "./types";

const readingIntro = /^(?:council\s+)?(?:will\s+|is scheduled to\s+)?(?:consider(?: giving)?|give|receive)\s+(.+? readings?)\s+(?:of|to|for)\s+(.+)$/i;
const readingStages = /^(?:first|second|third)(?:(?:,\s*(?:and\s+)?|\s+and\s+)(?:first|second|third))* readings?$/i;
const concreteClause = /\b(?:would|could|will|that|which|by|from|add(?:s|ing)?|remov(?:es?|ing)|replac(?:es?|ing)|allow(?:s|ing)?|requir(?:es?|ing)|increas(?:es?|ing)|reduc(?:es?|ing)|rais(?:es?|ing)|lower(?:s|ing)?|end(?:s|ing)?|prohibit(?:s|ing)?|mak(?:es?|ing)|chang(?:es?|ing)|introduc(?:es?|ing)|extend(?:s|ing)?|shorten(?:s|ing)?|shift(?:s|ing)?|move(?:s|d)?|moving)\b|[\d$%:;]/i;

function words(value: string) {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

function genericScheduledStage(text: string, title: string) {
  const normalized = text.replace(/\s+/g, " ").replace(/[.!?]$/, "");
  const parts = normalized.match(readingIntro);
  if (!parts || !readingStages.test(parts[1])) return null;

  const stage = parts[1].toLowerCase();
  const subject = parts[2].replace(/^the\s+/i, "");
  const topic = words(subject).join(" ");
  if (topic && ` ${words(title).join(" ")} `.includes(` ${topic} `)) return stage;

  // Legacy summaries sometimes name broad topics, rather than repeating the
  // formal title exactly. Only catch generic change phrases, not effects.
  const changes = subject.match(/^(?:proposed\s+)?(?:changes|amendments)\s+to\s+(.+)$/i);
  return changes && !/[.!?]/.test(changes[1]) && !concreteClause.test(changes[1]) ? stage : null;
}

export function agendaItemCopy(
  item: Pick<AgendaItem, "title" | "description" | "plain_english_summary">,
  preferPlannedDetail: boolean,
) {
  const summary = item.plain_english_summary?.trim();
  const description = item.description?.trim();
  if (!summary) return { summary: null, description: description || null, stage: null };
  const stage = preferPlannedDetail && genericScheduledStage(summary, item.title);
  if (stage && description) {
    const usedWords = new Set([...words(item.title), ...words(summary)]);
    const added = new Set(words(description).filter((word) => word.length > 3 && !usedWords.has(word)));
    const noDetail = /\b(?:does not|doesn't) (?:specify|describe|state|explain)\b/i;
    if (added.size >= 3 && !genericScheduledStage(description, item.title) && !noDetail.test(description)) {
      const title = words(item.title);
      const stageWords = words(stage).filter((word) => word !== "and");
      const titleHasStage = stageWords.every((word) =>
        title.includes(word) || (word === "readings" && title.includes("reading")),
      );
      return { summary: null, description, stage: titleHasStage ? null : stage };
    }
  }
  return { summary, description: null, stage: null };
}
