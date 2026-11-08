import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { applyThemeChoice, readThemeChoice, type ThemeChoice } from "../lib/theme";
import { cn } from "../lib/utils";

const CHOICES: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "Match my device", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

/** Light, dark, or follow the device, chosen on the settings page. The choice is kept in this browser (lib/theme.ts);
 * signed-out visitors get their device's setting. Renders "match my device" on the server, then the stored choice. */
export function ThemeChooser({ className = "" }: { className?: string }) {
  const [choice, setChoice] = useState<ThemeChoice>("system");
  useEffect(() => setChoice(readThemeChoice()), []);
  return (
    <div role="radiogroup" aria-label="Appearance" className={cn("inline-flex rounded-xl border border-zinc-200 bg-zinc-50 p-1", className)}>
      {CHOICES.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={choice === value}
          onClick={() => { applyThemeChoice(value); setChoice(value); }}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
            choice === value ? "bg-surface text-zinc-900 shadow-sm" : "text-zinc-600 hover:text-zinc-900",
          )}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  );
}
