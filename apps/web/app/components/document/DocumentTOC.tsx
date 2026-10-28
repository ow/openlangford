import { useState, useEffect } from "react";
import { List, ChevronDown, ChevronUp } from "lucide-react";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "../../lib/utils";
import { NativeSelect } from "../ui/native-select";

export interface TOCItem {
  id: string; // "section-1", "section-2", etc.
  title: string; // section_title
  order: number; // section_order
}

interface DocumentTOCProps {
  items: TOCItem[];
  activeId: string | null;
  variant: "desktop" | "mobile";
}

function scrollToSection(sectionId: string) {
  const el = document.getElementById(sectionId);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  history.replaceState(null, "", `#${sectionId}`);
}

export function DocumentTOC({ items, activeId, variant }: DocumentTOCProps) {
  // Deep-link support: scroll to hash on mount
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash) {
      requestAnimationFrame(() => {
        scrollToSection(hash);
      });
    }
  }, []);

  if (variant === "mobile") {
    return <MobileTOC items={items} activeId={activeId} />;
  }

  return <DesktopTOC items={items} activeId={activeId} />;
}

const PAGE_ONLY = /^page\s+\d+$/i;

/** Split "Page N" placeholder headings from real section titles. */
function splitItems(items: TOCItem[]) {
  return {
    named: items.filter((i) => !PAGE_ONLY.test(i.title.trim())),
    pages: items.filter((i) => PAGE_ONLY.test(i.title.trim())),
  };
}

function PageJump({ pages, onJump }: { pages: TOCItem[]; onJump?: () => void }) {
  if (pages.length === 0) return null;
  return (
    <NativeSelect
      aria-label="Go to page"
      value=""
      onChange={(e) => {
        if (e.currentTarget.value) {
          scrollToSection(e.currentTarget.value);
          onJump?.();
        }
      }}
    >
      <option value="">Go to page…</option>
      {pages.map((p) => (
        <option key={p.id} value={p.id}>
          {p.title}
        </option>
      ))}
    </NativeSelect>
  );
}

function DesktopTOC({
  items,
  activeId,
}: {
  items: TOCItem[];
  activeId: string | null;
}) {
  const { named, pages } = splitItems(items);
  return (
    <nav aria-label="Table of contents" className="space-y-4">
      <p className="text-sm font-semibold text-zinc-900">Contents</p>
      {named.length > 0 && (
        <ScrollArea className="max-h-[calc(100vh-14rem)]">
          <ul className="space-y-0.5">
            {named.map((item) => {
              const isActive = activeId === item.id;
              return (
                <li key={item.id}>
                  <a
                    href={`#${item.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      scrollToSection(item.id);
                    }}
                    className={cn(
                      "block border-l-2 py-1.5 pl-3 text-sm leading-snug transition-colors",
                      isActive
                        ? "border-brand-600 text-brand-800 font-semibold"
                        : "border-transparent text-zinc-500 hover:text-zinc-800 hover:border-zinc-300",
                    )}
                  >
                    {item.title}
                  </a>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      )}
      <PageJump pages={pages} />
    </nav>
  );
}

function MobileTOC({
  items,
  activeId,
}: {
  items: TOCItem[];
  activeId: string | null;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const activeItem = items.find((item) => item.id === activeId);
  const activeTitle = activeItem?.title ?? items[0]?.title ?? "Contents";

  return (
    <div className="sticky top-16 z-30 bg-surface border-b border-zinc-200">
      <button
        onClick={() => setIsOpen((prev) => !prev)}
        className="w-full flex items-center gap-2 px-4 py-2 text-sm text-zinc-700"
        aria-expanded={isOpen}
        aria-controls="mobile-toc-dropdown"
      >
        <List className="w-4 h-4 text-zinc-400 shrink-0" />
        <span className="truncate flex-1 text-left font-medium">
          {activeTitle}
        </span>
        {isOpen ? (
          <ChevronUp className="w-4 h-4 text-zinc-400 shrink-0" />
        ) : (
          <ChevronDown className="w-4 h-4 text-zinc-400 shrink-0" />
        )}
      </button>

      {isOpen && (
        <div
          id="mobile-toc-dropdown"
          className="absolute left-0 right-0 bg-surface border-b border-zinc-200 shadow-lg"
        >
          {splitItems(items).pages.length > 0 && (
            <div className="px-4 pt-3">
              <PageJump pages={splitItems(items).pages} onJump={() => setIsOpen(false)} />
            </div>
          )}
          <ScrollArea className="max-h-64">
            <ul className="py-1">
              {splitItems(items).named.map((item) => {
                const isActive = activeId === item.id;
                return (
                  <li key={item.id}>
                    <a
                      href={`#${item.id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        scrollToSection(item.id);
                        setIsOpen(false);
                      }}
                      className={cn(
                        "block px-4 py-2 text-sm transition-colors truncate",
                        isActive
                          ? "text-brand-800 font-semibold bg-brand-50 border-l-2 border-brand-600"
                          : "text-zinc-600 hover:text-zinc-800 hover:bg-zinc-50 border-l-2 border-transparent",
                      )}
                    >
                      {item.title}
                    </a>
                  </li>
                );
              })}
            </ul>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
