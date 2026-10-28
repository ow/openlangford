import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { applyThemeChoice, readThemeChoice, type ThemeChoice } from "../lib/theme";

const NEXT: Record<ThemeChoice, ThemeChoice> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<ThemeChoice, string> = { system: "Theme: match system", light: "Theme: light", dark: "Theme: dark" };
const ICON = { system: Monitor, light: Sun, dark: Moon };

/** Cycles system → light → dark. Renders the system icon on the server, then the stored choice. */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const [choice, setChoice] = useState<ThemeChoice>("system");
  useEffect(() => setChoice(readThemeChoice()), []);
  const Icon = ICON[choice];
  return (
    <button
      type="button"
      onClick={() => {
        const next = NEXT[choice];
        applyThemeChoice(next);
        setChoice(next);
      }}
      className={`rounded-full p-2 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 ${className}`}
      aria-label={`${LABEL[choice]} (click to change)`}
      title={LABEL[choice]}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
