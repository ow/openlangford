/**
 * Per-meeting email enqueue, run by the 5-minute cron before dispatch.
 *
 * Finds recently held meetings and asks the deployed `send-alerts` Edge
 * function to `enqueue` each one. The server still enforces the real rules
 * (ALERT_START_DATE cutoff, consent, municipality, publication, embedding
 * readiness, dedup on meeting/user/mode); this module only decides which
 * meetings to ask about and when to stop asking.
 *
 * Never a historical catch-up: candidates must be on/after
 * EMAIL_ALERT_START_DATE *and* within the last CANDIDATE_WINDOW_DAYS.
 */
import { DEFAULT_MUNICIPALITY } from "../app/lib/site-config";

export const CANDIDATE_WINDOW_DAYS = 14;
export const MAX_ENQUEUE_CALLS_PER_RUN = 5;
/** Leave meetings alone briefly after any update so ingestion can finish. */
export const SETTLE_MINUTES = 30;
export const MAX_ATTEMPTS = 12;
export const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
const RUN_BUDGET_MS = 25_000;
const CALL_TIMEOUT_MS = 10_000;
const PUBLISHED_STATUSES = ["Completed", "Occurred"] as const;

export type EnqueueEnv = {
  EMAIL_ALERT_DISPATCH_ENABLED?: string;
  ALERT_WORKER_KEY?: string;
  EMAIL_ALERT_START_DATE?: string;
  VITE_SUPABASE_URL: string;
};

export type CandidateMeeting = {
  id: number;
  meeting_date: string;
  status: string | null;
  has_minutes: boolean | null;
  has_transcript: boolean | null;
  updated_at: string | null;
  municipalities?: { slug?: string | null } | null;
};

export type ReceiptState = "pending" | "done" | "skipped" | "failed" | "expired";
export type Receipt = {
  meeting_id: number;
  state: ReceiptState;
  attempts: number;
  first_attempt_at: string;
  next_attempt_at: string;
  last_error: string | null;
  updated_at?: string;
};

type QueryResult<T> = { data: T | null; error: { code?: string; message?: string } | null };
/** The subset of the Supabase admin client this module uses. */
export type EnqueueDb = { from: (table: string) => any };

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

function validDate(value: string | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || isoDate(parsed) !== value ? null : value;
}

/** All three gates must be set; otherwise nothing runs. */
export function enqueueEnabled(env: EnqueueEnv) {
  return (
    env.EMAIL_ALERT_DISPATCH_ENABLED === "true" &&
    !!env.ALERT_WORKER_KEY &&
    validDate(env.EMAIL_ALERT_START_DATE) !== null
  );
}

/** Inclusive meeting-date window, or null when the start date is in the future. */
export function candidateWindow(startDate: string, now: Date) {
  const to = isoDate(now);
  const recent = isoDate(new Date(now.getTime() - CANDIDATE_WINDOW_DAYS * 86_400_000));
  const from = startDate > recent ? startDate : recent;
  return from > to ? null : { from, to };
}

export function isCandidate(
  m: CandidateMeeting,
  window: { from: string; to: string },
  now: Date,
  slug: string = DEFAULT_MUNICIPALITY.slug,
) {
  const settled =
    !m.updated_at ||
    new Date(m.updated_at).getTime() <= now.getTime() - SETTLE_MINUTES * 60_000;
  return (
    Number.isSafeInteger(m.id) &&
    m.id > 0 &&
    m.meeting_date >= window.from &&
    m.meeting_date <= window.to &&
    (PUBLISHED_STATUSES as readonly string[]).includes(m.status ?? "") &&
    (m.has_minutes === true || m.has_transcript === true) &&
    (m.municipalities?.slug ?? slug) === slug &&
    settled
  );
}

export async function loadCandidates(db: EnqueueDb, window: { from: string; to: string }, now: Date) {
  const settleCutoff = new Date(now.getTime() - SETTLE_MINUTES * 60_000).toISOString();
  const { data, error }: QueryResult<CandidateMeeting[]> = await db
    .from("meetings")
    .select("id,meeting_date,status,has_minutes,has_transcript,updated_at,municipalities!inner(slug)")
    .eq("municipalities.slug", DEFAULT_MUNICIPALITY.slug)
    .in("status", [...PUBLISHED_STATUSES])
    .or("has_minutes.eq.true,has_transcript.eq.true")
    .gte("meeting_date", window.from)
    .lte("meeting_date", window.to)
    .lte("updated_at", settleCutoff)
    .order("meeting_date", { ascending: false })
    .order("id", { ascending: false })
    .limit(50);
  if (error) throw new Error("Email enqueue candidates unavailable");
  // Re-check in code so a loose query can never widen the set.
  return (data ?? []).filter((m) => isCandidate(m, window, now));
}

const MISSING_TABLE = new Set(["PGRST205", "42P01"]);

/** Durable per-meeting receipts. `null` from load() means the table is absent. */
export function receiptStore(db: EnqueueDb) {
  return {
    async load(ids: number[]): Promise<Map<number, Receipt> | null> {
      if (!ids.length) return new Map();
      const { data, error }: QueryResult<Receipt[]> = await db
        .from("email_enqueue_receipts")
        .select("meeting_id,state,attempts,first_attempt_at,next_attempt_at,last_error")
        .in("meeting_id", ids);
      if (error) {
        if (error.code && MISSING_TABLE.has(error.code)) return null;
        throw new Error("Email enqueue receipts unavailable");
      }
      return new Map((data ?? []).map((r) => [r.meeting_id, r]));
    },
    async save(receipt: Receipt) {
      const { error } = await db
        .from("email_enqueue_receipts")
        .upsert({ ...receipt, updated_at: new Date().toISOString() }, { onConflict: "meeting_id" });
      if (error) console.error("[Email alerts] Enqueue receipt not saved; server dedup still applies");
    },
  };
}

export type Outcome = { state: "done" | "skipped" | "failed" | "retry"; error: string | null };

/** Mirrors the former pipeline outbox's handling of `enqueue` responses. */
export async function classifyResponse(response: Response): Promise<Outcome> {
  if (response.ok) {
    let body: any;
    try {
      body = await response.json();
    } catch {
      return { state: "retry", error: "Invalid enqueue receipt" };
    }
    if (body?.skipped === true) return { state: "skipped", error: null }; // off/test mode: never a later catch-up
    if (Number.isSafeInteger(body?.queued) && body.queued >= 0) return { state: "done", error: null };
    return { state: "retry", error: "Invalid enqueue receipt" };
  }
  // 503 covers the server's "Email matching data not ready" readiness error.
  if ([408, 425, 429].includes(response.status) || response.status >= 500)
    return { state: "retry", error: `HTTP ${response.status}` };
  return { state: "failed", error: `HTTP ${response.status}` };
}

function due(receipt: Receipt | undefined, now: Date) {
  if (!receipt) return true;
  return receipt.state === "pending" && new Date(receipt.next_attempt_at).getTime() <= now.getTime();
}

function expired(receipt: Receipt, now: Date) {
  return (
    receipt.attempts >= MAX_ATTEMPTS ||
    now.getTime() >= new Date(receipt.first_attempt_at).getTime() + RETRY_WINDOW_MS
  );
}

export type EnqueueSummary = {
  ran: boolean;
  candidates: number;
  calls: number;
  receipts: boolean;
  results: Array<{ meeting_id: number; state: ReceiptState }>;
};

export async function enqueueMeetingEmails(
  env: EnqueueEnv,
  db: EnqueueDb,
  fetcher: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<EnqueueSummary> {
  const summary: EnqueueSummary = { ran: false, candidates: 0, calls: 0, receipts: false, results: [] };
  if (!enqueueEnabled(env)) return summary;
  const started = now();
  const window = candidateWindow(env.EMAIL_ALERT_START_DATE!, started);
  if (!window) return summary;
  summary.ran = true;

  const candidates = await loadCandidates(db, window, started);
  summary.candidates = candidates.length;
  const store = receiptStore(db);
  const receipts = await store.load(candidates.map((m) => m.id));
  summary.receipts = receipts !== null;
  // Without receipts every run re-asks (the server dedups); rotate so a
  // backlog larger than one run's bound cannot starve older meetings.
  const offset =
    receipts || !candidates.length
      ? 0
      : (Math.floor(started.getTime() / 300_000) * MAX_ENQUEUE_CALLS_PER_RUN) % candidates.length;
  const ordered = [...candidates.slice(offset), ...candidates.slice(0, offset)];

  for (const meeting of ordered) {
    if (summary.calls >= MAX_ENQUEUE_CALLS_PER_RUN) break;
    const remaining = RUN_BUDGET_MS - (now().getTime() - started.getTime());
    if (remaining < 1_000) break;
    const previous = receipts?.get(meeting.id);
    const at = now();
    if (previous?.state === "pending" && expired(previous, at)) {
      await store.save({ ...previous, state: "expired", last_error: previous.last_error ?? "Retry window expired" });
      summary.results.push({ meeting_id: meeting.id, state: "expired" });
      continue;
    }
    if (!due(previous, at)) continue;

    summary.calls++;
    let outcome: Outcome;
    try {
      const response = await fetcher(`${env.VITE_SUPABASE_URL}/functions/v1/send-alerts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Alert-Worker-Key": env.ALERT_WORKER_KEY! },
        body: JSON.stringify({ action: "enqueue", meeting_id: meeting.id }),
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(CALL_TIMEOUT_MS, remaining)),
      });
      outcome = await classifyResponse(response);
    } catch {
      outcome = { state: "retry", error: "Enqueue transport unavailable" };
    }

    const attempts = (previous?.attempts ?? 0) + 1;
    const first = previous?.first_attempt_at ?? at.toISOString();
    let state: ReceiptState = outcome.state === "retry" ? "pending" : outcome.state;
    if (state === "pending" && expired({ ...(previous as Receipt), attempts, first_attempt_at: first }, now()))
      state = "expired";
    const delay = Math.min(3_600_000, 60_000 * 2 ** (attempts - 1));
    const receipt: Receipt = {
      meeting_id: meeting.id,
      state,
      attempts,
      first_attempt_at: first,
      next_attempt_at: new Date(now().getTime() + delay).toISOString(),
      last_error: outcome.error,
    };
    if (receipts) {
      await store.save(receipt);
      receipts.set(meeting.id, receipt);
    }
    summary.results.push({ meeting_id: meeting.id, state });
  }
  return summary;
}
