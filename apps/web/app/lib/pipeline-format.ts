/**
 * Worker errors arrive as raw Python reprs and absolute archive paths. Keep
 * the human-readable part for display; the raw text stays available.
 */
export function shortError(error: string) {
  const message = error.match(/['"]message['"]:\s*['"]([^'"]+)['"]/)?.[1];
  const text = (message ?? error)
    .replace(/\/\S*?\/archive\/[^/\s]+\//g, "archive/")
    .replace(/\s+/g, " ")
    .trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Postgres error `details` ("Key (identifier)=(…) already exists."), if any. */
export function errorDetails(error: string) {
  return error.match(/['"]details['"]:\s*['"]([^'"]+)['"]/)?.[1] ?? null;
}

// Fixed locale and zone so server and client render identical text.
const timeFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Vancouver",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});
const dateTimeFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Vancouver",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function formatLogTime(value: string) {
  return timeFormat.format(new Date(value));
}

export function formatDateTime(value: string) {
  return dateTimeFormat.format(new Date(value));
}

export function formatDuration(start: string, end: string) {
  const seconds = Math.max(
    0,
    Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000),
  );
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
