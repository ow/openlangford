import { describe, it, expect } from "vitest";
import { addToItem, placeHeldLetter, shortItemLabel, takeHeld, withLinkedPeople, writtenLetters, writtenSources } from "../written";

describe("withLinkedPeople", () => {
  const people = { 19: { id: 19, name: "Tanya Sunshine", slug: "tanya-sunshine" } };
  it("attaches the linked person to speakers and letter writers by person_id only", () => {
    const meta = withLinkedPeople({
      other: 1,
      participation: { overview: "o", speakers: [{ who: "Tanya Sunshine", person_id: 19 }, { who: "Tanya Sunshine" }] },
      written_participation: { version: "3", documents: [{ extracted_document_id: 1, document_id: 2, letters: [{ who: "Tanya Sunshine (Langvista Drive)", person_id: 19 }, { who: "Tanya Sunshine", person_id: 7 }] }] },
    } as Record<string, any>, people);
    expect(meta.other).toBe(1);
    expect(meta.participation.speakers.map((s: any) => s.person?.slug ?? null)).toEqual(["tanya-sunshine", null]);
    expect(writtenLetters(meta.written_participation).map((l: any) => l.person?.slug ?? null)).toEqual(["tanya-sunshine", null]);
    expect(meta.written_participation.version).toBe("3");
  });
  it("leaves items without participation alone", () => {
    const meta = { title: "x" };
    expect(withLinkedPeople(meta, people)).toBe(meta);
    expect(withLinkedPeople(null, people)).toBeNull();
    expect(withLinkedPeople({ written_participation: { letters: [{ who: "A", person_id: 19 }] } } as Record<string, any>, people).written_participation.letters[0].person.id).toBe(19);
  });
});

const held = (key: string) => ({
  who: `Writer ${key}`,
  position: "opposes",
  topic: "t",
  point: "p",
  key,
  candidates: [{ item_id: 2, probability: 0.5 }],
});

describe("writtenLetters", () => {
  it("flattens document groups and reads the prototype shape", () => {
    const written = { documents: [{ extracted_document_id: 1, document_id: 9, letters: [held("a")] }, { extracted_document_id: 2, document_id: 8, letters: [held("b")] }] };
    expect(writtenLetters(written).map((l) => l.who)).toEqual(["Writer a", "Writer b"]);
    expect(writtenLetters({ letters: [held("c")] })).toHaveLength(1);
    expect(writtenLetters(null)).toEqual([]);
    // Links go to the document viewer, which is keyed by the extracted document id.
    expect(writtenSources(written).map((s) => s.documentId)).toEqual([1, 2]);
  });
});

describe("placeHeldLetter", () => {
  const meetingMeta = {
    other: 1,
    written_unplaced: { "409": { document_id: 136, title: "Letters", fingerprint: "f", letters: [held("a"), held("b")] } },
  };

  it("moves the letter onto the item, records the decision and shrinks the queue", () => {
    const out = placeHeldLetter(meetingMeta, { foo: true }, "409", "a", 365)!;
    expect(out.meetingMeta.other).toBe(1);
    expect(out.meetingMeta.written_unplaced["409"].letters.map((l: any) => l.key)).toEqual(["b"]);
    expect(out.meetingMeta.written_placements["409"].a).toMatchObject({
      item: 365,
      by: "admin",
      letter: { who: "Writer a", position: "opposes", topic: "t", point: "p" },
    });
    const doc = out.itemMeta!.written_participation.documents[0];
    expect(doc).toMatchObject({ extracted_document_id: 409, document_id: 136, fingerprint: "f" });
    expect(doc.letters).toEqual([{ who: "Writer a", position: "opposes", topic: "t", point: "p" }]);
    expect((out.itemMeta as any).foo).toBe(true);
  });

  it("can dismiss a letter and clears the queue when empty", () => {
    const once = placeHeldLetter(meetingMeta, null, "409", "a", null)!;
    const twice = placeHeldLetter(once.meetingMeta, null, "409", "b", null)!;
    expect(twice.meetingMeta.written_unplaced).toBeUndefined();
    expect(twice.meetingMeta.written_placements["409"].a).toMatchObject({ item: null, by: "admin" });
    expect(twice.meetingMeta.written_placements["409"].b).toMatchObject({ item: null, by: "admin" });
    expect(twice.itemMeta).toBeNull();
  });

  it("returns null for an unknown letter", () => {
    expect(placeHeldLetter(meetingMeta, null, "409", "zzz", 1)).toBeNull();
  });
});

import { crossNotes, samePerson } from "../written";

describe("samePerson", () => {
  it("matches initials, streets and organisations to full names", () => {
    expect(samePerson("M. Wagner", "Mary Wagner (Deville Road)")).toBe(true);
    expect(samePerson("Courtney Frechette, Honeycomb Cannabis", "Courtney Frechette")).toBe(true);
    expect(samePerson("Tara Cadeau", "T. Cadeau (Glen Willow Place)")).toBe(true);
  });

  it("does not match different people or anonymous labels", () => {
    expect(samePerson("Mary Wagner", "Mark Wagner")).toBe(false);
    expect(samePerson("M. Wagner", "Mary Wagoner")).toBe(false);
    expect(samePerson("A resident (Dunford Avenue)", "A resident (Dunford Avenue)")).toBe(false);
    expect(samePerson("Wagner", "Mary Wagner")).toBe(false);
  });
});

describe("crossNotes", () => {
  it("notes both sides", () => {
    const notes = crossNotes([{ who: "M. Wagner" }, { who: "A resident" }], [{ who: "Mary Wagner (Deville Road)" }]);
    expect(notes.speaker("M. Wagner")).toBe("also wrote in");
    expect(notes.speaker("A resident")).toBeNull();
    expect(notes.letter("Mary Wagner (Deville Road)")).toBe("also spoke");
  });
});

describe("takeHeld and addToItem", () => {
  const meta = { written_unplaced: { "9": { document_id: 3, title: "T", fingerprint: "f", letters: [held("x"), held("y")] } } };
  it("takes one letter off the queue without touching the other", () => {
    const taken = takeHeld(meta, "9", "x", 5)!;
    expect(taken.meetingMeta.written_unplaced["9"].letters.map((l: any) => l.key)).toEqual(["y"]);
    expect(taken.letter).toEqual({ who: "Writer x", position: "opposes", topic: "t", point: "p" });
    expect(takeHeld(taken.meetingMeta, "9", "x", 5)).toBeNull(); // already taken
  });
  it("appends several letters to one document group", () => {
    const item = addToItem({}, "9", { document_id: 3, title: "T", fingerprint: "f" }, [held("x"), held("y")] as any);
    const again = addToItem(item, "9", { document_id: 3 }, [held("z")] as any);
    expect(again.written_participation.documents).toHaveLength(1);
    expect(again.written_participation.documents[0].letters).toHaveLength(3);
  });
});

describe("shortItemLabel", () => {
  it("keeps what tells similar bylaws apart", () => {
    expect(shortItemLabel("5.2", 'Bylaw NO. 2008 "Langford Zoning Bylaw, Amendment No. 641, (808, 812, 820 Arncote Avenue), Bylaw No. 2008, 2021"'))
      .toBe("5.2 Bylaw 2008 · 808, 812, 820 Arncote Avenue");
    expect(shortItemLabel("12.4", 'Bylaw NO. 2200 "Langford Official Community Plan Bylaw, 2025" (Second AND Third Readings AND Adoption)'))
      .toBe("12.4 Bylaw 2200 · second and third readings and adoption · Langf…");
    expect(shortItemLabel("8.1", 'Bylaw NO. 2200 "Langford Official Community Plan Bylaw No. 2200, 2025"'))
      .toBe("8.1 Bylaw 2200 · Langford Official Community Plan");
    expect(shortItemLabel(null, "REPORTS")).toBe("REPORTS");
  });
});

import { specificTerms } from "../written";

describe("specificTerms", () => {
  it("finds the identifiers the pipeline matches on", () => {
    const terms = specificTerms("Speedway lands for Business Park (BP9) zoning, Bylaw No. 1951, Z21-0040, 2207 Millstream Road");
    expect([...terms].sort()).toEqual(["2207 Millstream Rd", "BP9", "Bylaw 1951", "Z21-0040"]);
  });
});
