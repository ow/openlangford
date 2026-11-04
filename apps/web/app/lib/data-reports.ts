/** Readers' data-issue reports: the categories they choose from, and validation of what they send. */

/** While staff try reporting out, only moderators and admins see "Report an issue" and can send one. Set to false to
 * open it to every signed-in reader. */
export const REPORTS_STAFF_ONLY = true;

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

// The moderators' queue (shared by the server and the /admin/reports page).
export type ReportVerdict = "confirmed" | "likely" | "not_supported" | "unclear" | "privacy";
export const VERDICT_LABELS: Record<ReportVerdict, string> = {
  confirmed: "The records back the reader",
  likely: "Probably right, not fully checked",
  not_supported: "The records don't back it",
  unclear: "Can't tell from the records",
  privacy: "Privacy concern",
};

export type ReportAssessment = {
  verdict: ReportVerdict;
  summary: string;
  findings: string;
  proposed_fix: string | null;
  reply: string;
  model: string;
};

export type DataReport = {
  id: number;
  created_at: string;
  user_id: string | null;
  path: string;
  entry_key: string | null;
  quote: string | null;
  category: ReportCategory;
  note: string | null;
  suggestion: string | null;
  source_url: string | null;
  notify_reporter: boolean;
  status: "new" | "assessed" | "resolved" | "declined" | "duplicate";
  assessment: ReportAssessment | null;
  assessed_at: string | null;
  resolution: string | null;
  resolved_at: string | null;
  notified_at: string | null;
};

export const REPORT_FILTERS = [["open", "To decide"], ["resolved", "Fixed"], ["declined", "Declined"], ["all", "All"]] as const;
export type ReportFilter = (typeof REPORT_FILTERS)[number][0];
