import { describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  readStoredTheme,
  resolveTheme,
  themeStorageKey,
  watchSystemTheme,
} from "./theme.ts";

const storage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
};

describe("theme (ADR 0030)", () => {
  it("reads only known stored themes and defaults to dark", () => {
    expect(readStoredTheme(storage())).toBe("dark");
    expect(readStoredTheme(storage({ [themeStorageKey]: "light" }))).toBe(
      "light",
    );
    expect(readStoredTheme(storage({ [themeStorageKey]: "sepia" }))).toBe(
      "dark",
    );
    expect(
      readStoredTheme({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe("dark");
  });

  it("resolves system through prefers-color-scheme and applies to the root", () => {
    expect(resolveTheme("system", true)).toBe("light");
    expect(resolveTheme("system", false)).toBe("dark");
    expect(resolveTheme("light", false)).toBe("light");
    const root = {
      dataset: {} as Record<string, string | undefined>,
      style: { colorScheme: "" },
    } as unknown as HTMLElement;
    const mirror = storage();
    expect(applyTheme("light", root, mirror)).toBe("light");
    expect(root.dataset.theme).toBe("light");
    expect(root.dataset.themePreference).toBe("light");
    expect(root.style.colorScheme).toBe("light");
    expect(mirror.data.get(themeStorageKey)).toBe("light");
  });

  it("watches the device preference only for system", () => {
    const listeners: (() => void)[] = [];
    const matchMedia = vi.fn(() => ({
      matches: false,
      addEventListener: (_: string, listener: () => void) => {
        listeners.push(listener);
      },
      removeEventListener: (_: string, listener: () => void) => {
        listeners.splice(listeners.indexOf(listener), 1);
      },
    }));
    const onChange = vi.fn();
    watchSystemTheme("dark", onChange, matchMedia)();
    expect(matchMedia).not.toHaveBeenCalled();
    const stop = watchSystemTheme("system", onChange, matchMedia);
    expect(listeners).toHaveLength(1);
    listeners[0]?.();
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
    expect(listeners).toHaveLength(0);
  });
});
