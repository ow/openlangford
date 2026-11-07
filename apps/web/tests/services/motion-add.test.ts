import { describe, expect, it } from "vitest";
import { dispositionOf, normalise, quoteProblem } from "../../app/services/motion-add.server";

// The Sep 8, 2009 minutes, as the cleaner copy and the scanned copy give them.
const MARKDOWN = '### f) Bylaw No. 1239 **“City of Langford Housing Agreement (923, 927, 931 Walfred Road) Bylaw No. 1239, 2009”.** **(Adoption)** **Moved by:** Councillor Wade **Seconded:** Councillor Blackwell That Council adopt Bylaw No. 1239. **Carried.**';
const SCANNED_PREVIOUS = "MOVED BY: COUNCILLOR WADE SECONDED: COUNCILLOR BLACKWELL\n\nThat Council adopt Bylaw No. 1232.\n\nCARRIED.\n\nCARRIED.";
const SCANNED_THIS = 'f) BYLAW NO. 1239 (File No. 3900-1239) "City of Langford Housing Agreement" (ADOPTION)\nThat Council adopt Bylaw No. 1239.';
const motion = { motion_text: "That Council adopt Bylaw No. 1239.", result: "CARRIED" as const };

describe("quoteProblem", () => {
  it("accepts a quote found word for word that holds the motion and its outcome", () => {
    expect(quoteProblem({ ...motion, quote: "That Council adopt Bylaw No. 1239. Carried." }, [MARKDOWN])).toBeNull();
  });
  it("rejects an outcome that sits only in the neighbouring section", () => {
    expect(quoteProblem({ ...motion, quote: "That Council adopt Bylaw No. 1239." }, [SCANNED_PREVIOUS, SCANNED_THIS])).toMatch(/doesn't say the motion was carried/);
    expect(quoteProblem({ ...motion, quote: "That Council adopt Bylaw No. 1239. CARRIED." }, [SCANNED_PREVIOUS, SCANNED_THIS])).toMatch(/word for word/);
  });
  it("rejects a quote without the motion, or with the wrong outcome", () => {
    expect(quoteProblem({ ...motion, quote: "Carried." }, [MARKDOWN])).toMatch(/motion's wording/);
    expect(quoteProblem({ ...motion, result: "DEFEATED", quote: "That Council adopt Bylaw No. 1239. Carried." }, [MARKDOWN])).toMatch(/defeated/);
  });
  it("reads past OCR artefacts", () => {
    const scan = "That Council adopt the hous-\ning agree­ment — Bylaw No. 1239. CARRIED.";
    expect(quoteProblem({ motion_text: "That Council adopt the housing agreement - Bylaw No. 1239.", result: "CARRIED",
      quote: "That Council adopt the housing agreement – Bylaw No. 1239. Carried." }, [scan])).toBeNull();
    expect(normalise("“Quoted”  **bold**")).toBe("quoted bold");
  });
});

describe("dispositionOf", () => {
  it("files a motion to table or refer that way", () => {
    expect(dispositionOf("That Council table the rezoning application.")).toBe("Tabled");
    expect(dispositionOf("That the matter be referred to staff.")).toBe("Referred");
    expect(dispositionOf("That Council refer the application to the Planning Committee.")).toBe("Referred");
    expect(dispositionOf("That Council adopt Bylaw No. 1239.")).toBe("Substantive");
  });
});
