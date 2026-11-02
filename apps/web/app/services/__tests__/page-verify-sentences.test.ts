import { describe, expect, it } from "vitest";
import { sentences } from "../page-verify.server";

describe("sentences", () => {
  it("keeps figures with decimal points whole", () => {
    expect(sentences("The contract is worth $4,408,940.67 plus GST. It covers civil works.")).toEqual([
      "The contract is worth $4,408,940.67 plus GST.", "It covers civil works."]);
    expect(sentences("Parking drops to 1.5 spaces per unit. The rate is 2.05343 per $1,000.")).toHaveLength(2);
  });
  it("splits ordinary sentences", () => {
    expect(sentences("First one here. Second one here! Third?")).toEqual(["First one here.", "Second one here!", "Third?"]);
  });
});
