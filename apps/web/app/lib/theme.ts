// Light, dark, or follow the system. The choice lives in localStorage (per browser, no
// cookie, so cached pages stay shareable); the class is set before first paint.
export type ThemeChoice = "system" | "light" | "dark";
export const THEME_KEY = "theme";

/** Inline in <head>: applies the stored choice (or the system setting) before paint. */
export const THEME_SCRIPT = `(()=>{try{var c=localStorage.getItem("${THEME_KEY}")}catch(e){}var m=window.matchMedia("(prefers-color-scheme: dark)");function a(){var d=c==="dark"||(c!=="light"&&m.matches);document.documentElement.classList.toggle("dark",d)}a();m.addEventListener("change",function(){try{c=localStorage.getItem("${THEME_KEY}")}catch(e){}a()})})()`;

export function readThemeChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

/** Puts the stored choice (or the system setting) back on <html>. React 19 clears every attribute on <html> when it
 * takes the element over while hydrating, which drops the class THEME_SCRIPT set before paint; this runs right after
 * (ThemeSync) so the page and everything that reads the class, like the maps, keep the visitor's theme. */
export function syncTheme() {
  applyThemeChoice(readThemeChoice());
}

export function applyThemeChoice(choice: ThemeChoice) {
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch { /* private mode: still applies for this page */ }
  const dark = choice === "dark" || (choice === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}
