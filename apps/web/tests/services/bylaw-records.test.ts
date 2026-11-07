import { describe, expect, it } from "vitest";
import { bylawDatesLine, bylawNumbersIn, parseBylawDates } from "../../app/services/bylaw-records.server";

describe("parseBylawDates", () => {
  it("reads the dates printed on a signed bylaw", () => {
    const text = `2016". \nREAD A FIRST TIME this 18th  day of April, 2016. \nREAD A SECOND TIME this 18th day of April, 2016. \n` +
      `READ A THIRD TIME this 18th  day of April, 2016. \nADOPTED this 2nd day of May, 2016. \n(Certified orrect)`;
    expect(parseBylawDates(text)).toEqual({ first: "April 18, 2016", second: "April 18, 2016", third: "April 18, 2016", adopted: "May 2, 2016" });
  });

  it("tolerates OCR noise in the ordinal and a lower-case form", () => {
    const text = `READ A FIRST time on this 18th  day of April, 2016. \nREAD A SECOND time on this 18th  day of April, 2016. \n` +
      `READ A THIRD time on this 18th day of April, 2016. \nADOPTED this 2"d day of May, 2016.`;
    expect(parseBylawDates(text).adopted).toBe("May 2, 2016");
    expect(parseBylawDates(text).third).toBe("April 18, 2016");
  });

  it("reads combined readings and a reconsidered adoption", () => {
    const text = "READ A FIRST, SECOND AND THIRD TIME this 7th day of March, 2022. RECONSIDERED AND FINALLY ADOPTED this 21st day of March, 2022.";
    expect(parseBylawDates(text)).toEqual({ first: "March 7, 2022", second: "March 7, 2022", third: "March 7, 2022", adopted: "March 21, 2022" });
  });

  it("leaves blank dates on a draft alone", () => {
    const text = "READ A FIRST TIME this ____ day of ________, 2016. ADOPTED this ____ day of ________, 2016.";
    expect(parseBylawDates(text)).toEqual({});
    expect(bylawDatesLine({})).toMatch(/not legible/);
    expect(bylawDatesLine({ first: "April 18, 2016" })).toBe("read a first time April 18, 2016; no adoption date is legible on the signed copy.");
  });
});

describe("bylawNumbersIn", () => {
  it("finds every bylaw number a title or identifier names", () => {
    expect(bylawNumbersIn("2016-2020 Financial Plan Bylaw and Tax Rates Bylaw", "Bylaw No. 1628; Bylaw No. 1629")).toEqual(["1628", "1629"]);
    expect(bylawNumbersIn("Bylaw No 1630", null)).toEqual(["1630"]);
  });
});
