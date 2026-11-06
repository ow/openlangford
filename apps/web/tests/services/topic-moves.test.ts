import { describe, expect, it } from "vitest";
import { identifierBylaws, lifecycleEvidence } from "../../app/services/topic-moves.server";

// The same cases as the pipeline's tests/core/test_matter_lifecycle.py: only an explicit final action changes a status.
describe("lifecycleEvidence", () => {
  const topic = { title: "Amenity Cost Charge", identifier: "Bylaw 2275" };
  it.each([
    ["THAT Council adopt Bylaw No. 2275.", "CARRIED", "Adopted"],
    ["THAT Council adopt Bylaw No. 2275.", "DEFEATED", null],
    ["THAT Council give third reading to Bylaw No. 2275.", "CARRIED", null],
    ["THAT Committee recommend that Council adopt Bylaw No. 2275.", "CARRIED", null],
    ["THAT Council adopt Bylaw No. 2275 subject to provincial approval.", "CARRIED", null],
    ["THAT Council direct staff to prepare Bylaw No. 2275 for adoption.", "CARRIED", null],
    ["THAT Council adopt Bylaw No. 2270.", "CARRIED", null],
    ["THAT Council adopt the report regarding Bylaw No. 2275.", "CARRIED", null],
    ["THAT Council adopt a plan under Bylaw No. 2275.", "CARRIED", null],
    ["THAT Council adopt the policy and direct staff to prepare Bylaw No. 2275.", "CARRIED", null],
    ["THAT Council adopt Bylaw No. 2222 and direct staff to prepare Bylaw No. 2275.", "CARRIED", null],
    ["THAT Council repeal Bylaw No. 2275.", "CARRIED", "Repealed"],
  ])("%s (%s)", (text, result, expected) => {
    expect(lifecycleEvidence(topic, { id: 3, meeting_id: 4, result, text_content: text })?.status ?? null).toBe(expected);
  });
});

describe("identifierBylaws", () => {
  it("reads the bylaws of a compound identifier, never a year", () => {
    expect([...identifierBylaws("Bylaw No. 1160; REZ 2025-01")]).toEqual(["Bylaw 1160"]);
    expect([...identifierBylaws("1852; 1853; 2024")]).toEqual(["Bylaw 1852", "Bylaw 1853"]);
    expect([...identifierBylaws("Bylaws Nos. 10, 11 and 12")]).toEqual(["Bylaw 10", "Bylaw 11", "Bylaw 12"]);
  });
});
