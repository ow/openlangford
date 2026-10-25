import { describe, it, expect } from "vitest";
import { placeHeldLetter, writtenLetters, writtenSources } from "../written";

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
    expect(writtenSources(written).map((s) => s.documentId)).toEqual([9, 8]);
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
    expect(out.meetingMeta.written_placements).toEqual({ "409": { a: 365 } });
    const doc = out.itemMeta!.written_participation.documents[0];
    expect(doc).toMatchObject({ extracted_document_id: 409, document_id: 136, fingerprint: "f" });
    expect(doc.letters).toEqual([{ who: "Writer a", position: "opposes", topic: "t", point: "p" }]);
    expect(out.itemMeta!.foo).toBe(true);
  });

  it("can dismiss a letter and clears the queue when empty", () => {
    const once = placeHeldLetter(meetingMeta, null, "409", "a", null)!;
    const twice = placeHeldLetter(once.meetingMeta, null, "409", "b", null)!;
    expect(twice.meetingMeta.written_unplaced).toBeUndefined();
    expect(twice.meetingMeta.written_placements).toEqual({ "409": { a: null, b: null } });
    expect(twice.itemMeta).toBeNull();
  });

  it("returns null for an unknown letter", () => {
    expect(placeHeldLetter(meetingMeta, null, "409", "zzz", 1)).toBeNull();
  });
});
