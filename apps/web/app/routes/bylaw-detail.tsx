import { SITE_NAME } from "../lib/site-name";
import type { Route } from "./+types/bylaw-detail";
import { getBylawById } from "../services/bylaws";
import { getSupabaseAdminClient } from "../lib/supabase.server";
import { Link } from "react-router";
import { ogImageUrl, ogUrl } from "../lib/og";
import { bylawPath, matterPath } from "../lib/paths";
import { resolveSlugParam } from "../lib/slug-params.server";
import { ChevronRight } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { SectionHeading } from "../components/ui/section-heading";
import { DetailHeader } from "../components/ui/detail-header";
import { formatDate } from "../lib/utils";
import { displayTitle, matterTitle } from "../lib/display-text";
import { amendmentsFromText, bylawLead, bylawStatus, bylawSummaryParts } from "../lib/bylaw-summary";

export const meta: Route.MetaFunction = ({ data }) => {
  if (!data?.bylaw) return [{ title: `Bylaw | ${SITE_NAME}` }];
  const b = data.bylaw as any;
  const label = b.bylaw_number ? `${displayTitle(b.title)} (No. ${b.bylaw_number})` : displayTitle(b.title);
  const title = `${label} | ${SITE_NAME}`;
  const status = bylawStatus(b.status)?.label;
  const description = bylawLead(b.plain_english_summary) || `${b.title}${status ? ` — ${status}` : ""}`;
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: label },
    { property: "og:description", content: description },
    { property: "og:type", content: "article" },
    { property: "og:url", content: ogUrl(bylawPath(b)) },
    { property: "og:image", content: ogImageUrl(label, { subtitle: status, type: "bylaw" }) },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { name: "twitter:card", content: "summary_large_image" },
  ];
};

const FULL_TEXT_LIMIT = 40_000;

export async function loader({ params, request }: Route.LoaderArgs) {
  const supabase = getSupabaseAdminClient();
  const resolved = await resolveSlugParam(supabase, "bylaws", params.id, request, (b) => bylawPath(b), "Bylaw Not Found");

  try {
    const bylaw = await getBylawById(supabase, String(resolved.id));
    if (!bylaw) throw new Response("Bylaw Not Found", { status: 404 });
    // Long bylaws (zoning, OCP) run to megabytes; ship a readable excerpt and point to the PDF.
    const fullText: string = (bylaw as any).full_text || "";
    const amendments = amendmentsFromText(fullText);
    const truncated = fullText.length > FULL_TEXT_LIMIT;
    return {
      bylaw: { ...bylaw, full_text: truncated ? fullText.slice(0, FULL_TEXT_LIMIT) : fullText },
      amendments,
      fullTextTruncated: truncated,
    };
  } catch (error) {
    console.error(error);
    throw new Response("Bylaw Not Found", { status: 404 });
  }
}

const shortDate = (d: string | null | undefined) =>
  d ? formatDate(d, { year: "numeric", month: "short", day: "numeric" }) : "";

function statusVariant(status: string | null | undefined) {
  if (!status || status === "Active") return null;
  if (/defeat|fail|withdraw|rescind|repeal/i.test(status)) return "danger" as const;
  if (/adopt|complete|approv|pass|closed|resolved/i.test(status)) return "success" as const;
  return "muted" as const;
}

export default function BylawDetail({ loaderData }: Route.ComponentProps) {
  const { bylaw, amendments, fullTextTruncated } = loaderData;
  const { summary, keyRules, whoItAffects } = bylawSummaryParts(bylaw);
  const status = bylawStatus(bylaw.status);
  const pdfHref = bylaw.source_url || `/api/bylaws/${bylaw.id}/download`;

  // Linked matters (canonical only), most recently discussed first.
  const matters = (bylaw.matters || [])
    .filter((m: any) => !m.meta?.canonical_matter_id)
    .map((m: any) => {
      const dates = (m.agenda_items || [])
        .map((item: any) => item.meetings?.meeting_date)
        .filter(Boolean)
        .sort();
      return { ...m, lastDate: dates[dates.length - 1] || null, firstDate: dates[0] || null };
    })
    .sort((a: any, b: any) => String(b.lastDate || "").localeCompare(String(a.lastDate || "")));

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="container mx-auto max-w-4xl px-4 py-12">
        <header className="mb-10">
          <DetailHeader
            className="mb-0"
            back={{ to: "/bylaws", label: "Bylaws" }}
            meta={[
              bylaw.bylaw_number ? (
                <span className="tabular-nums">Bylaw No. {bylaw.bylaw_number}</span>
              ) : null,
              bylaw.category || null,
              bylaw.year ? <span className="tabular-nums">Adopted {bylaw.year}</span> : null,
              status ? status.label : null,
            ]}
            title={displayTitle(bylaw.title)}
            badges={
              status?.tone === "danger" ? <Badge variant="danger">{status.label}</Badge> : undefined
            }
            actions={
              <a
                href={pdfHref}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center rounded-lg border border-zinc-200 bg-surface px-3.5 py-2 text-sm font-semibold text-zinc-800 shadow-xs transition-colors hover:border-zinc-300 hover:bg-zinc-50"
              >
                Official PDF
              </a>
            }
          />

          {summary && (
            <p className="mt-5 max-w-2xl text-base leading-relaxed text-zinc-700">{summary}</p>
          )}
          {whoItAffects && (
            <p className="mt-4 max-w-2xl border-l-2 border-brand-500 pl-3 text-sm leading-relaxed text-zinc-600">
              <span className="font-semibold text-zinc-900">Who it affects: </span>
              {whoItAffects}
            </p>
          )}
        </header>

        <div className="space-y-12">
          {keyRules.length > 0 && (
            <section>
              <SectionHeading title="Key rules" description="The parts residents most often run into. The PDF is the official text." />
              <ul className="space-y-2.5 rounded-2xl border border-zinc-200 bg-surface px-5 py-4 shadow-sm">
                {keyRules.map((rule, i) => (
                  <li key={i} className="flex gap-3 text-sm leading-relaxed text-zinc-800">
                    <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
                    {rule}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {matters.length > 0 && (
            <section>
              <SectionHeading
                title="At council"
                description={`${matters.length} ${matters.length === 1 ? "matter" : "matters"} about this bylaw`}
              />
              <ul className="space-y-3">
                {matters.map((m: any) => {
                  const variant = statusVariant(m.status);
                  return (
                    <li key={m.id}>
                      <Link
                        to={matterPath(m)}
                        className="group block rounded-2xl border border-zinc-200 bg-surface p-5 shadow-sm transition-colors hover:border-brand-200"
                      >
                        <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
                          {variant && <Badge variant={variant}>{m.status}</Badge>}
                          {m.lastDate && (
                            <span className="tabular-nums">
                              {m.firstDate && m.firstDate !== m.lastDate
                                ? `${shortDate(m.firstDate)} – ${shortDate(m.lastDate)}`
                                : shortDate(m.lastDate)}
                            </span>
                          )}
                        </div>
                        <h3 className="flex items-start justify-between gap-3 text-base font-semibold leading-snug text-zinc-900 group-hover:text-brand-700">
                          {matterTitle(m)}
                          <ChevronRight aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-zinc-300 group-hover:text-brand-600" />
                        </h3>
                        {m.plain_english_summary && (
                          <p className="mt-1.5 text-sm leading-relaxed text-zinc-600">{m.plain_english_summary}</p>
                        )}
                        {m.meta?.status_line && (
                          <p className="mt-2 text-sm text-zinc-500">{m.meta.status_line}</p>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {amendments.length > 0 && (
            <section>
              <SectionHeading
                title="Amendments"
                description="This version includes these amending bylaws."
              />
              <ul className="divide-y divide-zinc-100 rounded-2xl border border-zinc-200 bg-surface text-sm shadow-sm">
                {amendments.map((a) => {
                  const m = matters.find((x: any) => new RegExp(`\\b0*${a.bylawNumber}\\b`).test(x.identifier || ""));
                  return (
                    <li key={a.bylawNumber} className="flex items-center justify-between gap-4 px-5 py-3">
                      <span className="text-zinc-800">
                        Bylaw No. <span className="tabular-nums">{a.bylawNumber}</span>
                        <span className="text-zinc-500"> · adopted {a.adopted}</span>
                      </span>
                      {m && (
                        <Link to={matterPath(m)} className="shrink-0 font-medium text-brand-700 hover:text-brand-800">
                          How it passed
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <section>
            <details className="group rounded-2xl border border-zinc-200 bg-surface shadow-sm">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-base font-semibold text-zinc-900">
                Full text
                <span className="text-sm font-medium text-brand-700 group-open:hidden">Show</span>
                <span className="hidden text-sm font-medium text-brand-700 group-open:inline">Hide</span>
              </summary>
              <div className="max-h-[640px] overflow-y-auto border-t border-zinc-100 p-5 sm:p-6">
                {bylaw.full_text ? (
                  <>
                    <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-zinc-700">
                      {bylaw.full_text}
                    </pre>
                    {fullTextTruncated && (
                      <p className="mt-4 text-sm text-zinc-500">
                        The bylaw continues in the{" "}
                        <a href={pdfHref} target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:text-brand-800">
                          official PDF
                        </a>
                        .
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-zinc-500">
                    Full text isn&apos;t available.{" "}
                    <a href={pdfHref} target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:text-brand-800">
                      Open the PDF
                    </a>{" "}
                    instead.
                  </p>
                )}
              </div>
            </details>
          </section>
        </div>
      </div>
    </div>
  );
}
