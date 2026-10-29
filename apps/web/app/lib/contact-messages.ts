/** Client-safe contact-message helpers shared by the admin page and the notification email. */
export const CONTACT_ADMIN_PATH = "/admin/contact";
export const CONTACT_REPLY_SUBJECT = "Re: your message to Open Langford";

export const CONTACT_FILTERS = ["open", "handled", "all"] as const;
export type ContactFilter = (typeof CONTACT_FILTERS)[number];

export type ContactMessage = {
  id: string;
  name: string | null;
  email: string;
  message: string;
  created_at: string;
  handled_at: string | null;
  notified_at: string | null;
};

export function contactFilter(value: string | null): ContactFilter {
  return (CONTACT_FILTERS as readonly string[]).includes(value || "") ? (value as ContactFilter) : "open";
}

/** mailto link for replying from the admin page. */
export function replyMailto(email: string) {
  return `mailto:${encodeURIComponent(email).replace(/%40/g, "@")}?subject=${encodeURIComponent(CONTACT_REPLY_SUBJECT)}`;
}

/** Times in the civic timezone. */
export function civicTime(iso: string) {
  return new Date(iso).toLocaleString("en-CA", {
    timeZone: "America/Vancouver",
    dateStyle: "medium",
    timeStyle: "short",
  });
}
