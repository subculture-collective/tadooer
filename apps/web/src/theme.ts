import type { ApplicationTheme } from "@suite/contracts";

/**
 * Theme application (ADR 0030). The owner's preference is server-side; the
 * browser mirrors it in localStorage so the first paint after a reload uses
 * the right palette before the record is fetched. `system` follows
 * `prefers-color-scheme` and re-applies when it changes.
 */
export const themeStorageKey = "suite.theme";
export type ResolvedTheme = "dark" | "light";

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;
interface ThemeQuery {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}
type MatchMedia = (query: string) => ThemeQuery;

const browserStorage = (): ThemeStorage | undefined =>
  typeof localStorage === "undefined" ? undefined : localStorage;
const browserMatchMedia = (): MatchMedia | undefined =>
  typeof matchMedia === "undefined" ? undefined : matchMedia;
const browserRoot = (): HTMLElement | undefined =>
  typeof document === "undefined" ? undefined : document.documentElement;

const isTheme = (value: unknown): value is ApplicationTheme =>
  value === "dark" || value === "light" || value === "system";

export const readStoredTheme = (
  storage: Pick<Storage, "getItem"> | undefined = browserStorage(),
): ApplicationTheme => {
  try {
    const stored = storage?.getItem(themeStorageKey);
    return isTheme(stored) ? stored : "dark";
  } catch {
    return "dark";
  }
};

export const systemPrefersLight = (
  query: MatchMedia | undefined = browserMatchMedia(),
): boolean => query?.("(prefers-color-scheme: light)").matches ?? false;

export const resolveTheme = (
  theme: ApplicationTheme,
  prefersLight = systemPrefersLight(),
): ResolvedTheme =>
  theme === "system" ? (prefersLight ? "light" : "dark") : theme;

/** Sets `data-theme` and `color-scheme` on the root element and stores the choice. */
export const applyTheme = (
  theme: ApplicationTheme,
  root: HTMLElement | undefined = browserRoot(),
  storage: Pick<Storage, "setItem"> | undefined = browserStorage(),
): ResolvedTheme => {
  const resolved = resolveTheme(theme);
  if (root !== undefined) {
    root.dataset.theme = resolved;
    root.dataset.themePreference = theme;
    root.style.colorScheme = resolved;
  }
  try {
    storage?.setItem(themeStorageKey, theme);
  } catch {
    // Storage may be unavailable (private mode); the preference is server-side.
  }
  return resolved;
};

/** Re-applies `system` when the device preference changes. Returns a cleanup. */
export const watchSystemTheme = (
  theme: ApplicationTheme,
  onChange: () => void,
  query: MatchMedia | undefined = browserMatchMedia(),
): (() => void) => {
  if (theme !== "system" || query === undefined) return () => undefined;
  const list = query("(prefers-color-scheme: light)");
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
};
