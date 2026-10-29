import { expect, it } from "vitest";
import { isSafeUrl, renderMarkdown } from "~/components/markdown-content";

it("escapes raw HTML in document text but keeps <br> line breaks in table cells", () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\nText <img src=x onerror="alert(1)"> and <iframe src="https://evil.example"></iframe>\n\n| A | B |\n|---|---|\n| one<br>two | x<br/>y |');
  expect(html).not.toMatch(/<script|<img|<iframe/i);
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  expect(html).toContain("one<br>two");
  expect(html).toContain("x<br>y");
});

it("drops javascript: and data: links but keeps ordinary ones and email autolinks", () => {
  const html = renderMarkdown('[a](javascript:alert(1)) [b](JaVa\tScRiPt:alert(1)) ![c](data:text/html,x) [d](https://www.langford.ca/x) [e](/meetings) <mayor@langford.ca>');
  expect(html).not.toMatch(/javascript|data:text/i);
  expect(html).toContain('href="https://www.langford.ca/x"');
  expect(html).toContain('href="/meetings"');
  expect(html).toContain('href="mailto:mayor@langford.ca"');
  expect(isSafeUrl("vbscript:x")).toBe(false);
  expect(isSafeUrl("#section")).toBe(true);
});

it("still renders normal markdown and escapes text", () => {
  const html = renderMarkdown("## Heading\n\n**Bold** & 5 < 6");
  expect(html).toContain("<h2>Heading</h2>");
  expect(html).toContain("<strong>Bold</strong> &amp; 5 &lt; 6");
});
