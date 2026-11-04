/** Readers' data-issue reports: the categories they choose from, and validation of what they send. */

export const REPORT_CATEGORIES = [
  { value: "wrong_fact", label: "Something's wrong (a fact, date, number or name)" },
  { value: "wrong_topic", label: "It belongs to a different topic or meeting" },
  { value: "missing", label: "Something's missing" },
  { value: "private", label: "Private information that shouldn't be here" },
  { value: "other", label: "Something else" },
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number]["value"];

export type NewReport = {
  path: string;
  entryKey: string | null;
  quote: string | null;
  category: ReportCategory;
  note: string | null;
  suggestion: string | null;
  sourceUrl: string | null;
  notify: boolean;
};

const text = (value: unknown, max: number) => {
  const s = typeof value === "string" ? value.trim() : "";
  return s ? s.slice(0, max) : null;
};

/** A report from the panel, cleaned, or an error to show the reader. */
export function parseReport(input: unknown): { report: NewReport } | { error: string } {
  const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const path = text(body.path, 500);
  if (!path || !path.startsWith("/") || path.startsWith("//") || path.startsWith("/admin") || path.startsWith("/api")) {
    return { error: "This page can't be reported." };
  }
  const category = REPORT_CATEGORIES.find((c) => c.value === body.category)?.value;
  if (!category) return { error: "Choose what's wrong." };
  const quote = text(body.quote, 2000);
  const note = text(body.note, 2000);
  if (!quote && !note) return { error: "Tell us what's wrong." };
  const sourceUrl = text(body.sourceUrl, 1000);
  if (sourceUrl && !/^https?:\/\/[^\s]+$/i.test(sourceUrl)) return { error: "The source should be a web link." };
  const entryKey = text(body.entryKey, 200);
  return {
    report: {
      path: path.split("#")[0].split("?")[0],
      entryKey: entryKey && /^[a-z]+-\d+$/i.test(entryKey) ? entryKey : null,
      quote, category, note, suggestion: text(body.suggestion, 2000), sourceUrl,
      notify: body.notify !== false,
    },
  };
}
