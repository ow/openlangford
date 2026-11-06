/** Read/display contract only; it does not enable or schedule sending. */
export const EMAIL_STATUSES = [
  "queued",
  "attempting",
  "accepted",
  "delivered",
  "failed",
  "bounced",
  "complained",
  "suppressed",
] as const;
export const EMAIL_TYPES = ["meeting_digest", "agenda_preview", "pre_meeting", "staff_role", "data_report"] as const;
