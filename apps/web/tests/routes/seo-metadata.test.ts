import { expect, it } from "vitest";
import { meta as meetingMeta } from "../../app/routes/meeting-detail";
import { meta as documentsMeta } from "../../app/routes/meeting-documents";
import { meta as explorerMeta } from "../../app/routes/meeting-explorer";
import { meta as electionMeta } from "../../app/routes/election-detail";
import { meta as privacyMeta } from "../../app/routes/privacy";
import { meta as termsMeta } from "../../app/routes/terms";
import { meta as contactMeta } from "../../app/routes/contact";
import { meta as participantMeta } from "../../app/routes/participant-profile";
import { meta as searchMeta } from "../../app/routes/search";
import { meta as loginMeta } from "../../app/routes/login";

const value = (meta: any[], name: string) => meta.find(m => m.name === name || m.property === name)?.content;
it.each([
  ["meeting", meetingMeta], ["documents", documentsMeta], ["explorer", explorerMeta],
])("%s distinguishes meeting dates without copying summary bullets", (_name, meta) => {
  const render = (date: string) => meta({ data: { meeting: { id: 1, slug: `${date}-regular-council`, title: "Regular Council", meeting_date: date, summary: "- A long bullet list\n- More details" } } } as any) as any[];
  if (_name === "meeting") {
    // The meeting page speaks in its own words: highlights first, else its summary as sentences.
    const withSummary = render("2026-05-19");
    expect(value(withSummary, "description")).toBe("May 19, 2026: A long bullet list. More details.");
    const adopted = meta({ data: { meeting: { id: 1, slug: "2026-05-19-regular-council", title: "Regular Council", meeting_date: "2026-05-19",
      summary: "- Adopted garbage collection rules with a $280 maximum fee (Bylaw 2299).\n- Advanced rezoning at 953 Walfred Road." } } } as any) as any[];
    expect(value(adopted, "description")).toBe("May 19, 2026: Council adopted garbage collection rules with a $280 maximum fee. Advanced rezoning at 953 Walfred Road.");
    const highlighted = meta({ data: { meeting: { id: 1, slug: "2026-05-19-regular-council", title: "Regular Council", meeting_date: "2026-05-19",
      summary: "- x", meta: { highlights: { description: "May 19, 2026: Council approved a new 911 dispatch deal." } } } } } as any) as any[];
    expect(value(highlighted, "description")).toBe("May 19, 2026: Council approved a new 911 dispatch deal.");
    const event = highlighted.find((m) => m["script:ld+json"])["script:ld+json"]["@graph"].find((t: any) => t["@type"] === "Event");
    expect(event.name).toBe("Regular Council — May 19, 2026");
    return;
  }
  const may = render("2026-05-19");
  expect(may.find(m => m.title)?.title).toContain("May 19, 2026");
  expect(render("2026-04-20").find(m => m.title)?.title).toContain("April 20, 2026");
  expect(value(may, "description")).toContain("May 19, 2026");
  expect(value(may, "description")).not.toMatch(/bullet|\n/);
  expect(value(may, "description").length).toBeLessThan(180);
  expect(value(may, "og:description")).toBe(value(may, "description"));
  expect(value(may, "og:url")).toMatch(/^https:\/\/openlangford.ca\/meetings\/2026-05-19-/);
});
it.each(["2022-10-15", "2018-10-20"])("gives Langford election context for %s", date => {
  const meta = electionMeta({ data: { election: { name: "General election", classification: "General", election_date: date } } } as any) as any[];
  expect(value(meta, "description")).toMatch(/Langford general election on October .*: candidates and recorded results by office\./);
});
it.each([["privacy", privacyMeta], ["terms", termsMeta], ["contact", contactMeta]])("%s has dedicated sharing metadata", (path, meta) => {
  const tags = meta();
  expect(value(tags, "og:url")).toBe(`https://openlangford.ca/${path}`);
  expect(value(tags, "og:description")).toBe(value(tags, "description"));
  expect(value(tags, "twitter:image")).toMatch(/^https:/);
  expect(value(tags, "twitter:title")).not.toContain("Council Meeting Intelligence");
});
it("shares public participation at the participant canonical URL", () => {
  const meta = participantMeta({ data: { person: { id: 25, name: "Alex Resident", slug: "alex-resident" } } } as any) as any[];
  expect(value(meta, "og:url")).toBe("https://openlangford.ca/participants/alex-resident");
  expect(value(meta, "og:type")).toBe("profile");
  expect(value(meta, "twitter:description")).toContain("member of the public");
  const withComments = participantMeta({ data: { person: { id: 25, name: "Alex Resident", slug: "alex-resident" },
    summary: { meetingCount: 3, agendaItemCount: 4, firstDate: "2022-02-07", lastDate: "2025-12-15" } } } as any) as any[];
  expect(value(withComments, "description")).toContain("at 3 meetings, 2022–2025, on 4 agenda items. Read what they said.");
  expect(value(withComments, "description").length).toBeLessThanOrEqual(155);
});
it.each([undefined, "budget", "What is the budget?"])("noindexes search variant %s", query => {
  expect(value(searchMeta({ data: { query } } as any) as any[], "robots")).toBe("noindex, follow");
});
it("noindexes login", () => {
  expect(value(loginMeta({} as any) as any[], "robots")).toBe("noindex, follow");
});
