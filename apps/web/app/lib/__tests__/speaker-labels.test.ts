import { describe, expect, it } from "vitest";
import { formatSpeakerName, isUnidentifiedSpeaker, UNKNOWN_SPEAKER } from "../speaker-labels";

describe("formatSpeakerName", () => {
  it("turns diarization labels into plain words", () => {
    expect(formatSpeakerName("Speaker_1")).toBe("Speaker 1");
    expect(formatSpeakerName("SPEAKER_07")).toBe("Speaker 7");
    expect(formatSpeakerName("speaker 12")).toBe("Speaker 12");
  });

  it("names unknown speakers in sentence case", () => {
    expect(formatSpeakerName(null)).toBe(UNKNOWN_SPEAKER);
    expect(formatSpeakerName("")).toBe(UNKNOWN_SPEAKER);
    expect(formatSpeakerName("Unknown Speaker")).toBe(UNKNOWN_SPEAKER);
    expect(formatSpeakerName("Unknown")).toBe(UNKNOWN_SPEAKER);
  });

  it("leaves real names alone", () => {
    expect(formatSpeakerName("Scott Goodmanson")).toBe("Scott Goodmanson");
    expect(formatSpeakerName("Speakerman")).toBe("Speakerman");
  });
});

describe("isUnidentifiedSpeaker", () => {
  it("flags labels and unknowns, not names", () => {
    expect(isUnidentifiedSpeaker("Speaker_1")).toBe(true);
    expect(isUnidentifiedSpeaker("Speaker 1")).toBe(true);
    expect(isUnidentifiedSpeaker("Unknown speaker")).toBe(true);
    expect(isUnidentifiedSpeaker(undefined)).toBe(true);
    expect(isUnidentifiedSpeaker("Lillian Szpak")).toBe(false);
  });
});
