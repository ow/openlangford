/**
 * Fork-level defaults, used when municipality data isn't loaded (error pages,
 * meta before data). Change these when forking for another town.
 */
export const DEFAULT_MUNICIPALITY = {
  slug: "langford",
  short_name: "Langford",
  name: "City of Langford",
  province: "BC",
  /** Nominatim viewbox (minLon,minLat,maxLon,maxLat) used to bias geocoding. */
  geocodeViewBox: "-123.62,48.39,-123.45,48.50",
  /** Where residents find the official agendas, minutes and video. */
  meetingPortalUrl: "https://pub-langford.escribemeetings.com",
  /** Where council meets; used as the default meeting location. */
  cityHall: { name: "Langford City Hall", streetAddress: "877 Goldstream Avenue", locality: "Langford", region: "BC" },
  /** IANA time zone for meeting dates and times. */
  timezone: "America/Vancouver",
} as const;

/**
 * Neighbourhood names offered in onboarding/settings (stored as free text on
 * user_profiles.neighborhood). Langford: commonly used area names
 * (Wikipedia / VREB).
 */
export const NEIGHBORHOODS: readonly string[] = [
  "Bear Mountain",
  "City Centre / Langford Proper",
  "Florence Lake",
  "Glen Lake",
  "Goldstream",
  "Happy Valley",
  "Humpback",
  "Langford Lake",
  "Luxton",
  "Mill Hill / Atkins",
  "Millstream / North Langford",
  "Olympic View / Latoria",
  "Thetis Heights",
  "Triangle Mountain / Walfred",
  "Westhills",
];
