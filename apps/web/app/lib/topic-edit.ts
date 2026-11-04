/** Staff edits to a topic page (shared by the server and the review bar's edit panel). */

export const EDIT_FIELDS = ["title", "summary", "status_line", "image"] as const;
export type EditField = (typeof EDIT_FIELDS)[number];

export const FIELD_LABELS: Record<EditField, string> = {
  title: "Title", summary: "Summary", status_line: "Where it stands", image: "Feature photo",
};

/** The photo's caption on the page (matter-detail's IMAGE_CAPTION); none reads "From the staff report". */
export const IMAGE_KINDS = ["rendering", "site_photo", "location", "site_plan"] as const;
export const IMAGE_KIND_LABELS: Record<(typeof IMAGE_KINDS)[number], string> = {
  rendering: "What's proposed", site_photo: "The site today", location: "Where it is", site_plan: "Proposed layout",
};

export type ImageCandidate = { id: number; url: string; width: number | null; height: number | null; page: number | null; report: string | null };

export type TopicEditState = {
  title: string;
  summary: string;
  statusLine: string;
  image: { r2_key: string; url: string | null; kind: string | null } | null;
  /** Fields a person set: the pipeline leaves them alone until they're reset. */
  locked: EditField[];
  editedAt: string | null;
  /** Agenda items the topic gained since the last edit. */
  newEntries: number;
  candidates: ImageCandidate[];
};
