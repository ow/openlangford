/**
 * A resident's place for nearby alerts. We keep only a map point rounded to three decimal places
 * (about 110 m north–south, 75 m east–west here: roughly a block) and the street name. The address
 * someone types is used once to find the point and is never stored.
 */
export type SavedPlace = { lat: number; lng: number; label: string };

const round = (value: number) => Math.round(value * 1000) / 1000;

export function roundedPoint(lat: number, lng: number) {
  return { lat: round(lat), lng: round(lng) };
}

export function validPoint(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  const la = Number(lat);
  const ln = Number(lng);
  if (lat === null || lat === "" || lng === null || lng === "") return null;
  if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) return null;
  return roundedPoint(la, ln);
}

/** A short, safe street label: no digits (so no house numbers), at most 80 characters. */
export function cleanLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.replace(/\d+/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
  return label || null;
}
