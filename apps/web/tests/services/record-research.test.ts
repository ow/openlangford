import { describe, expect, it } from "vitest";
import { prefetchQueries } from "../../app/services/record-research.server";

describe("prefetchQueries", () => {
  const context = `This is the topic page /matters/x ("Development variance permit application for 3296 Jacklin Rd").\nTHE TOPIC'S SIGNED BYLAWS:\n…`;
  it("takes bylaw and file numbers, street addresses and the topic title from the question", () => {
    const q = `What was proposed at this step? The entry reads: "July 17, 2017 · Bylaw NO. 1695 "Langford Zoning Bylaw, Amendment No. 123" File No. Z16-0021 for 3296 Jacklin Rd".`;
    expect(prefetchQueries(q, context)).toEqual(["3296 Jacklin Rd", "Z16-0021", "1695", "Development variance permit application for 3296 Jacklin Rd"]);
  });
  it("finds an address with a two-word street name, and never more than four searches", () => {
    const q = `Is topic 2985 the same project? "667 Rockingham Road lot-width variance", "2543 Mill Hill Road", Bylaw No. 1200, Bylaw No. 1201, Bylaw No. 1202.`;
    const out = prefetchQueries(q, `This is the topic page /matters/b ("Building bylaw violation notice").`);
    expect(out).toHaveLength(4);
    expect(out).toContain("667 Rockingham Road");
    expect(out).toContain("2543 Mill Hill Road");
  });
  it("gives nothing for a question with no numbers, addresses or title", () => {
    expect(prefetchQueries("What happened?", "")).toEqual([]);
  });
});
