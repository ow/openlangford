import { afterEach, describe, expect, it, vi } from "vitest";
import { syncTheme } from "../../app/lib/theme";

/** A page where React has just cleared <html>'s class: the stored choice (or the system setting) must come back. */
function page(stored: string | null, systemDark: boolean) {
  const classes = new Set<string>();
  vi.stubGlobal("document", { documentElement: { classList: { toggle: (c: string, on: boolean) => { if (on) classes.add(c); else classes.delete(c); return on; }, contains: (c: string) => classes.has(c) } } });
  vi.stubGlobal("localStorage", { getItem: () => stored, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: systemDark }) });
  return classes;
}
afterEach(() => vi.unstubAllGlobals());

describe("syncTheme", () => {
  it("restores dark when the visitor chose it, whatever the system says", () => {
    const classes = page("dark", false);
    syncTheme();
    expect(classes.has("dark")).toBe(true);
  });
  it("follows the system when nothing is stored", () => {
    const dark = page(null, true);
    syncTheme();
    expect(dark.has("dark")).toBe(true);
    const light = page(null, false);
    syncTheme();
    expect(light.has("dark")).toBe(false);
  });
  it("stays light when the visitor chose light on a dark system", () => {
    const classes = page("light", true);
    syncTheme();
    expect(classes.has("dark")).toBe(false);
  });
});
