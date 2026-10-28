import { cn } from "../lib/utils";
import { DEFAULT_MUNICIPALITY } from "~/lib/site-config";
import {
  parseMinutesIntoBlocks,
  type MinutesBlock,
} from "../lib/minutes-parser";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";

/**
 * Convert HTML comment anchors to navigable span elements.
 * Transforms <!-- item:X --> to <span id="item-X" class="anchor"></span>
 * Transforms <!-- motion:X-N --> to <span id="motion-X-N" class="anchor"></span>
 */
function processAnchors(markdown: string): string {
  if (!markdown) return "";

  // Convert item anchors: <!-- item:8.1.a --> to <span id="item-8.1.a"></span>
  let processed = markdown.replace(
    /<!--\s*item:([^\s>]+)\s*-->/g,
    '<span id="item-$1" class="scroll-mt-24 block"></span>',
  );

  // Convert motion anchors: <!-- motion:8.1.a-1 code:C-18-22 --> to <span id="motion-8.1.a-1" data-code="C-18-22"></span>
  processed = processed.replace(
    /<!--\s*motion:([^\s>]+)(?:\s+code:([^\s>]+))?\s*-->/g,
    (_, motionId, code) => {
      const dataCode = code ? ` data-code="${code}"` : "";
      return `<span id="motion-${motionId}" class="scroll-mt-24 block"${dataCode}></span>`;
    },
  );

  return processed;
}

export function BlockRenderer({ block }: { block: MinutesBlock }) {
  switch (block.type) {
    case "header":
      return (
        <h3 className="font-sans font-bold text-zinc-900 pt-8 pb-2 mb-4 text-lg tracking-tight border-b border-zinc-200">
          {block.content}
        </h3>
      );
    case "motion_meta":
      return (
        <div className="font-sans font-medium text-zinc-500 text-xs mt-6 mb-1">
          {block.content}
        </div>
      );
    case "motion_text":
      return (
        <div className="relative my-4 py-3 pl-6 pr-4 bg-zinc-50/50 border-l-4 border-zinc-300 rounded-r-xl">
          <p className="text-zinc-900 font-medium text-base leading-relaxed">
            {block.content}
          </p>
        </div>
      );
    case "result":
      return (
        <div
          className={cn(
            "font-sans font-medium text-xs py-0.5 px-2.5 rounded-full inline-flex items-center gap-2 mt-2 mb-6 border",
            block.isCarried
              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
              : "bg-red-50 text-red-700 border-red-200",
          )}
        >
          <div
            className={cn(
              "w-1.5 h-1.5 rounded-full",
              block.isCarried ? "bg-emerald-500" : "bg-red-500",
            )}
          />
          {block.content}
        </div>
      );
    case "list_item":
      return (
        <div className="pl-8 -indent-4 py-1 leading-relaxed text-zinc-800 text-base">
          • {block.content}
        </div>
      );
    case "paragraph":
      return (
        <p className="py-2 leading-relaxed text-zinc-800 text-base text-justify [hyphens:auto]">
          {block.content}
        </p>
      );
    case "divider":
      return (
        <h4 className="font-sans font-semibold text-zinc-500 mt-8 mb-4 text-sm border-b border-zinc-100 pb-1">
          {block.content}
        </h4>
      );
    default:
      return null;
  }
}

interface FormattedTextProps {
  content?: string;
  markdown?: string;
  className?: string;
  municipalityName?: string;
  province?: string;
}

export function FormattedText({
  content,
  markdown,
  className,
  municipalityName,
  province,
}: FormattedTextProps) {
  // If we have markdown, use the new renderer
  if (markdown) {
    return (
      <div
        className={cn(
          "min-h-screen bg-[#FDFBF7] py-12 px-4 md:px-8",
          className,
        )}
      >
        <div className="max-w-[210mm] mx-auto bg-surface shadow-xl shadow-zinc-900/5 border border-zinc-200/50 min-h-[297mm] p-[20mm] md:p-[25mm] print:shadow-none print:border-none print:p-0 print:w-full">
          {/* Document Header */}
          <div className="mb-12 border-b-2 border-zinc-900 pb-6 flex justify-between items-end">
            <div className="space-y-2">
              <div className="text-sm text-zinc-500">Official record</div>
              <div className="text-4xl font-sans font-extrabold tracking-tight text-zinc-900">
                Meeting Minutes
              </div>
            </div>
            <div className="text-right text-xs font-sans text-zinc-500 leading-relaxed">
              {municipalityName || DEFAULT_MUNICIPALITY.name}
              <br />
              {province || "British Columbia"}
            </div>
          </div>

          <article
            className="prose prose-zinc prose-sm md:prose-base max-w-none
            prose-headings:font-sans prose-headings:font-bold prose-headings:text-black
            prose-h1:text-3xl prose-h1:border-b prose-h1:border-zinc-200 prose-h1:pb-2 prose-h1:mb-8
            prose-h2:text-xl prose-h2:mt-10
            prose-h3:text-lg prose-h3:text-zinc-800 prose-h3:mt-6
            prose-p:leading-relaxed prose-p:text-justify prose-p:text-zinc-700
            prose-blockquote:border-l-4 prose-blockquote:border-brand-200 prose-blockquote:bg-brand-50/30 prose-blockquote:py-2 prose-blockquote:px-6 prose-blockquote:rounded-r-lg prose-blockquote:not-italic prose-blockquote:text-zinc-700
            prose-li:text-zinc-700 prose-li:marker:text-zinc-400
            prose-strong:font-bold prose-strong:text-zinc-900
            prose-table:text-sm prose-table:border prose-table:border-zinc-200 prose-table:my-8
            prose-th:bg-zinc-50 prose-th:p-3 prose-th:text-left prose-th:font-bold prose-th:text-zinc-900
            prose-td:p-3 prose-td:border-t prose-td:border-zinc-100
           "
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeRaw]}
            >
              {processAnchors(markdown)}
            </ReactMarkdown>
          </article>

          {/* Document Footer */}
          <div className="mt-24 pt-8 border-t border-zinc-100 text-center text-xs text-zinc-400">
            End of document
          </div>
        </div>
      </div>
    );
  }

  // Fallback to simpler parser if no markdown
  const blocks = content ? parseMinutesIntoBlocks(content) : [];

  return (
    <div className={cn("bg-surface min-h-screen", className)}>
      <div className="max-w-3xl mx-auto py-16 px-8">
        <div className="mb-8 rounded-2xl border border-dashed border-zinc-300 bg-surface/60 p-5 text-sm text-zinc-500">
          This is a preview of the extracted text. The fully formatted version is still being processed.
        </div>
        {blocks.map((block, idx) => (
          <BlockRenderer key={idx} block={block} />
        ))}
      </div>
    </div>
  );
}
