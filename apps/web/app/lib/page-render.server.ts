/**
 * Renders one of the site's own pages in-process, as an anonymous visitor gets it, for checks that read a page
 * the way a resident does (services/page-check.server.ts). workers/app.ts registers the React Router handler.
 */
type Renderer = (request: Request) => Promise<Response>;
let renderer: Renderer | null = null;

export function setPageRenderer(render: Renderer) {
  renderer = render;
}

export async function renderPage(origin: string, path: string): Promise<string> {
  if (!renderer) throw new Error("Page rendering is not available here.");
  const response = await renderer(new Request(new URL(path, origin), { headers: { Accept: "text/html" } }));
  if (!response.ok) throw new Error(`The page returned ${response.status}.`);
  return response.text();
}
