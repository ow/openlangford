import { SITE_NAME } from "../lib/site-name";
import { DEFAULT_MUNICIPALITY } from "../lib/site-config";
import { roundedPoint, type SavedPlace } from "../lib/saved-place";

/**
 * Turns a typed address, or a point from the browser, into a saved place: a map point rounded to
 * about a block and the street name, never the house number. The address itself is only passed to
 * OpenStreetMap's Nominatim for the lookup and is not stored or logged.
 */

const NOMINATIM = "https://nominatim.openstreetmap.org";
const headers = { "User-Agent": `${SITE_NAME}/1.0 (civic platform)` };

type NominatimPlace = {
  lat: string;
  lon: string;
  address?: Record<string, string | undefined>;
};

function streetLabel(address: NominatimPlace["address"]) {
  const a = address ?? {};
  return a.road || a.pedestrian || a.footway || a.neighbourhood || a.suburb || a.hamlet || a.village || a.town || a.city || DEFAULT_MUNICIPALITY.short_name;
}

function toPlace(result: NominatimPlace): SavedPlace {
  return { ...roundedPoint(Number(result.lat), Number(result.lon)), label: streetLabel(result.address) };
}

export class GeocodeUnavailable extends Error {}

export async function geocodeAddress(address: string): Promise<SavedPlace | null> {
  const query = `${address}, ${DEFAULT_MUNICIPALITY.short_name}, ${DEFAULT_MUNICIPALITY.province}, Canada`;
  const url = `${NOMINATIM}/search?q=${encodeURIComponent(query)}&format=json&addressdetails=1&limit=1&viewbox=${DEFAULT_MUNICIPALITY.geocodeViewBox}&bounded=0`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new GeocodeUnavailable(`Nominatim ${response.status}`);
  const results = (await response.json()) as NominatimPlace[];
  return results[0] ? toPlace(results[0]) : null;
}

/** The street near a point. The point is rounded before it leaves the site. */
export async function placeNear(lat: number, lng: number): Promise<SavedPlace> {
  const point = roundedPoint(lat, lng);
  const url = `${NOMINATIM}/reverse?lat=${point.lat}&lon=${point.lng}&format=json&addressdetails=1&zoom=17`;
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new GeocodeUnavailable(`Nominatim ${response.status}`);
  const result = (await response.json()) as NominatimPlace & { error?: string };
  return { ...point, label: result.error ? DEFAULT_MUNICIPALITY.short_name : streetLabel(result.address) };
}
