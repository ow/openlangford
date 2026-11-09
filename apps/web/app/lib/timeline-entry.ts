/**
 * What a row on a timeline is made of, for every page that has one (an address's chronology, a topic's history).
 * A page builds entries from its own records; components/timeline/ draws them, so a change to how a quote, a source
 * or a year looks is made once.
 */
export type Outcome = { label: string; variant: "success" | "danger" | "warning" | "muted" };

export type TimelineEntry = {
  key: string;
  date: string;             // YYYY-MM-DD
  kind: "step" | "mention" | "report" | "source" | "closed";
  /** Who said it, for things outside a meeting: "City annual report 2019", "Reported by Victoria News",
   * "Closed meeting". Meeting rows are labelled from ``meeting`` and ``outcome``. */
  label: string;
  headline: string;
  /** Shown instead of the day when the date is approximate ("Spring 2019"); ``date`` still orders the row. */
  dateLabel?: string | null;
  /** Under a written headline: the entry's own title ("Monthly Accounts Payable - January to August 2019"). */
  subline?: string | null;
  /** A line above a quote, in the entry's own voice (a staff-approved heading for a report row). */
  lead?: string | null;
  detail?: string | null;
  /** The detail (or, for a report, the headline) is the record's own words, shown as a quote; false for a line staff wrote. */
  quoted?: boolean;
  href?: string | null;
  external?: boolean;
  /** An archived copy of an outside link (the Wayback Machine), for when the link dies. */
  archiveHref?: string | null;
  /** The label on the link pill ("Victoria News", "Watch on YouTube"); short, since a pill is one line. */
  linkTitle?: string | null;
  /** The page's full title, shown on hover over the pill. */
  linkHint?: string | null;
  /** Pictures kept with a source (the City's FOI table and letter): thumbnails that open full size, or the PDF. */
  images?: { url: string; href: string; pdf: boolean; w: number; h: number; alt: string; caption: string | null }[] | null;
  /** A small one-line row on the rail instead of a card (thin context: a notice, an advisory). */
  compact?: boolean;
  /** A YouTube video to embed in the row. */
  video?: { id: string; title: string } | null;
  /** A picture from this step's report (the topic's chosen one), shown beside it. */
  image?: { url: string; alt: string } | null;
  topic?: { slug: string; title: string } | null;
  outcome?: Outcome | null;
  /** The meeting a step or mention belongs to; rows from one meeting fold into one card. */
  meeting?: { id: number; title: string | null; href: string; committee: boolean } | null;
  /** data-review-entry key, so the review bar can outline the row ("item-12", "matter-5"). */
  reviewKey?: string | null;
};
