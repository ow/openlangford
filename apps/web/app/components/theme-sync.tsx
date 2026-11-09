import { useLayoutEffect } from "react";
import { syncTheme } from "../lib/theme";

/** Re-applies the theme class after hydration, before the browser paints: React clears <html>'s attributes when it
 * hydrates (see syncTheme in lib/theme.ts), so without this a dark page turns light as soon as the app starts. */
export function ThemeSync() {
  useLayoutEffect(() => { syncTheme(); }, []);
  return null;
}
