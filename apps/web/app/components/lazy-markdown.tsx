import { lazy, Suspense } from "react";
import type { Components } from "react-markdown";

const MarkdownEngine = lazy(() => import("./markdown-engine"));

/**
 * Markdown for content that only appears after hydration (search answers and source previews). The markdown engine
 * (~330 KB) loads on first use instead of being preloaded on every page that imports this; until then the text shows plain.
 * Does not enable raw HTML.
 */
export function LazyMarkdown({ children, components }: { children: string; components?: Components }) {
  return (
    <Suspense fallback={<p className="whitespace-pre-wrap">{children}</p>}>
      <MarkdownEngine components={components}>{children}</MarkdownEngine>
    </Suspense>
  );
}
