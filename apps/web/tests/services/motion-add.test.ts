import { describe, expect, it } from "vitest";
import { dispositionOf, moveProblem, normalise, quoteProblem } from "../../app/services/motion-add.server";

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

describe("moveProblem", () => {
  it("accepts a container motion that names the item's address", () => {
    expect(moveProblem("Disposition of 2104 Longspur Dr", "That Council approve the disposition and direct staff to enter into a purchase and sale agreement with Nextview Construction Inc. for the sale of 2104 Longspur")).toBeNull();
    expect(moveProblem("Application to Amend the Zoning Designation of 940 and 949 Flatman Avenue (File No. Z11-0017)",
      "That Council: 1. Direct staff to prepare a bylaw to amend the zoning of the property at 940 and 949 Flatman Avenue")).toBeNull();
  });
  it("rejects a motion about a different number", () => {
    expect(moveProblem("Disposition of 2104 Longspur Dr", "That Council give Bylaw No. 1945 second and third readings.")).toMatch(/2104/);
  });
  it("falls back to the title's distinctive words when it has no number", () => {
    expect(moveProblem("Naming rights agreement for Westhills Stadium", "That Council authorize the mayor to execute the naming rights agreement with Westhills for the stadium.")).toBeNull();
    expect(moveProblem("Naming rights agreement for Westhills Stadium", "That Council approve the minutes of December 7, 2020.")).toMatch(/name what the item is about/);
  });
});
