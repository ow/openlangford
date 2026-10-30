import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import Terms from "../../app/routes/terms";

it("points readers to Langford's official meeting portal, not another town's", () => {
  const Stub = createRoutesStub([{ path: "/terms", Component: Terms }]);
  const html = renderToString(createElement(Stub, { initialEntries: ["/terms"] }));
  expect(html).toContain('href="https://pub-langford.escribemeetings.com"');
  expect(html).toMatch(/Langford(<!-- -->)? council meetings website/);
  expect(html).not.toMatch(/viewroyal|civicweb/i);
});
