import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/** react-markdown + GFM, no raw HTML. Imported only through lazy-markdown.tsx so it stays out of the initial bundle. */
export default function MarkdownEngine({ children, components }: { children: string; components?: Components }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </ReactMarkdown>
  );
}
