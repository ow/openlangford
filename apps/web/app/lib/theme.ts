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

export function applyThemeChoice(choice: ThemeChoice) {
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch { /* private mode: still applies for this page */ }
  const dark = choice === "dark" || (choice === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}
