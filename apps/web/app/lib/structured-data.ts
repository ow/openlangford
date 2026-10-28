import { SITE_ORIGIN } from "./og";
import { SITE_NAME } from "./site-name";

/**
 * schema.org JSON-LD for search engines, as a React Router meta descriptor. <Meta> renders it as
 * <script type="application/ld+json"> and escapes <, >, & and U+2028/9 (<...), so record text
 * can never close the script tag.
 */
type Thing = Record<string, unknown>;

const CONTEXT = "https://schema.org";
const abs = (path: string) => (path.startsWith("http") ? path : `${SITE_ORIGIN}${path}`);
/** Drop null/undefined/"" fields so nodes stay small and valid. */
const compact = (thing: Thing): Thing => Object.fromEntries(Object.entries(thing).filter(([, v]) => v !== null && v !== undefined && v !== ""));

export function jsonLd(...things: Thing[]) {
  return { "script:ld+json": things.length === 1 ? { "@context": CONTEXT, ...things[0] } : { "@context": CONTEXT, "@graph": things } };
}

export function postalAddress(streetAddress?: string | null): Thing {
  return compact({ "@type": "PostalAddress", streetAddress, addressLocality: "Langford", addressRegion: "BC", addressCountry: "CA" });
}

export const SITE_ORGANIZATION: Thing = {
  "@type": "Organization",
  "@id": `${SITE_ORIGIN}/#organization`,
  name: SITE_NAME,
  url: `${SITE_ORIGIN}/`,
  logo: `${SITE_ORIGIN}/apple-touch-icon.png`,
};

export const CITY_OF_LANGFORD: Thing = { "@type": "GovernmentOrganization", name: "City of Langford", url: "https://www.langford.ca", address: postalAddress("877 Goldstream Ave") };

export const CITY_HALL: Thing = { "@type": "Place", name: "Langford City Hall", address: postalAddress("877 Goldstream Ave") };

/** Home page: the site, its publisher and the sitelinks search box (/search?q=). */
export function websiteGraph() {
  return jsonLd(
    {
      "@type": "WebSite",
      "@id": `${SITE_ORIGIN}/#website`,
      url: `${SITE_ORIGIN}/`,
      name: SITE_NAME,
      inLanguage: "en-CA",
      publisher: { "@id": SITE_ORGANIZATION["@id"] },
      potentialAction: {
        "@type": "SearchAction",
        target: { "@type": "EntryPoint", urlTemplate: `${SITE_ORIGIN}/search?q={search_term_string}` },
        "query-input": "required name=search_term_string",
      },
    },
    SITE_ORGANIZATION,
  );
}

/** Home is implied as the first crumb; the last crumb is the page itself. */
export function breadcrumbList(trail: [name: string, path: string][]): Thing {
  return {
    "@type": "BreadcrumbList",
    itemListElement: [["Home", "/"] as [string, string], ...trail].map(([name, path], i) => ({ "@type": "ListItem", position: i + 1, name, item: abs(path) })),
  };
}

export function meetingEvent(m: { title: string; meeting_date: string; status?: string | null; summary?: string | null }, path: string, description?: string): Thing {
  return compact({
    "@type": "Event",
    "@id": `${abs(path)}#event`,
    name: `${m.title}`,
    startDate: m.meeting_date.slice(0, 10),
    url: abs(path),
    description,
    eventStatus: `${CONTEXT}/${/cancel/i.test(m.status || "") ? "EventCancelled" : /postpone/i.test(m.status || "") ? "EventPostponed" : "EventScheduled"}`,
    eventAttendanceMode: `${CONTEXT}/OfflineEventAttendanceMode`,
    location: CITY_HALL,
    organizer: CITY_OF_LANGFORD,
  });
}

/** ISO 8601 duration ("PT1H39M5S") from seconds. */
export function isoDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}${r || (!h && !m) ? `${r}S` : ""}`;
}

/**
 * The meeting recording, embedded on the meeting page from the City's eSCRIBE player. eSCRIBE
 * has no thumbnails, so the page's share card stands in. recordedAt ties it to the meeting Event.
 */
export function meetingVideo(
  m: { title: string; meeting_date: string; video_url?: string | null },
  path: string,
  opts: { description: string; thumbnailUrl: string; durationSeconds?: number | null },
): Thing | null {
  if (!m.video_url || !/^https:\/\//.test(m.video_url)) return null;
  return compact({
    "@type": "VideoObject",
    name: `${m.title} — ${m.meeting_date.slice(0, 10)} (Langford council meeting video)`,
    description: opts.description,
    uploadDate: m.meeting_date.slice(0, 10),
    thumbnailUrl: opts.thumbnailUrl,
    duration: opts.durationSeconds ? isoDuration(opts.durationSeconds) : null,
    embedUrl: m.video_url,
    url: abs(path),
    inLanguage: "en-CA",
    publisher: CITY_OF_LANGFORD,
    recordedAt: { "@id": `${abs(path)}#event` },
  });
}

export function propertyPlace(p: { address: string; geo?: { lat?: number; lng?: number } | null }, path: string, description?: string): Thing {
  const geo = p.geo?.lat != null && p.geo?.lng != null ? { "@type": "GeoCoordinates", latitude: p.geo.lat, longitude: p.geo.lng } : null;
  return compact({ "@type": "Place", name: `${p.address}, Langford`, url: abs(path), description, address: postalAddress(p.address), geo });
}

export function bylawLegislation(b: { title: string; bylaw_number?: string | null; year?: number | null }, path: string, description?: string): Thing {
  return compact({
    "@type": "Legislation",
    name: b.title,
    legislationIdentifier: b.bylaw_number ? `Bylaw No. ${b.bylaw_number}` : null,
    legislationDate: b.year ? String(b.year) : null,
    legislationJurisdiction: "Langford, BC, Canada",
    legislationPassedBy: CITY_OF_LANGFORD,
    url: abs(path),
    description,
  });
}

export function councilPerson(p: { name: string; image_url?: string | null }, jobTitle: string, path: string, description?: string): Thing {
  return compact({ "@type": "Person", name: p.name, jobTitle, image: p.image_url, url: abs(path), description, worksFor: CITY_OF_LANGFORD });
}
