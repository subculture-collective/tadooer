import { describe, expect, it } from "vitest";
import {
  applicationPreferencesSchema,
  defaultApplicationPreferences,
  normalizeShortcutBinding,
  normalizeShortcutOverrides,
  resolveShortcutBindings,
  shortcutActions,
  shortcutConflicts,
} from "./application-preferences.ts";

describe("application preferences (ADR 0030)", () => {
  it("accepts the defaults and rejects unknown keys and bad values", () => {
    expect(
      applicationPreferencesSchema.parse(defaultApplicationPreferences),
    ).toEqual(defaultApplicationPreferences);
    for (const invalid of [
      { ...defaultApplicationPreferences, theme: "blue" },
      { ...defaultApplicationPreferences, language: "EN" },
      { ...defaultApplicationPreferences, dateTimeLocale: "not a locale!" },
      { ...defaultApplicationPreferences, firstDayOfWeek: 7 },
      { ...defaultApplicationPreferences, defaultStartPage: "boards" },
      { ...defaultApplicationPreferences, defaultEstimateMinutes: 0 },
      { ...defaultApplicationPreferences, dueDateNotificationHour: 24 },
      { ...defaultApplicationPreferences, extra: true },
      {
        ...defaultApplicationPreferences,
        defaultTaskReminder: { kind: "before_start", minutes: 7 },
      },
    ])
      expect(applicationPreferencesSchema.safeParse(invalid).success).toBe(
        false,
      );
  });

  it("normalizes bindings and rejects unusable ones", () => {
    expect(normalizeShortcutBinding("ctrl+k")).toBe("Ctrl+K");
    expect(normalizeShortcutBinding("Shift+Ctrl+arrowup")).toBe(
      "Ctrl+Shift+ArrowUp",
    );
    expect(normalizeShortcutBinding("Ctrl++")).toBe("Ctrl++");
    expect(normalizeShortcutBinding("?")).toBe("?");
    expect(normalizeShortcutBinding("cmd+s")).toBe("Meta+S");
    expect(normalizeShortcutBinding(" a ")).toBe("A");
    expect(normalizeShortcutBinding("Esc")).toBe("Escape");
    for (const bad of ["", "Ctrl+", "Hyper+K", "Ctrl+Unknown", "ab"])
      expect(normalizeShortcutBinding(bad)).toBeUndefined();
  });

  it("resolves overrides over defaults and reports conflicts", () => {
    const defaults = resolveShortcutBindings({});
    expect(defaults.get("command_bar.open")).toBe("Ctrl+K");
    expect(defaults.get("navigate.settings")).toBeNull();
    const overrides = resolveShortcutBindings({
      "navigate.settings": "Ctrl+,",
      "help.shortcuts": null,
    });
    expect(overrides.get("navigate.settings")).toBe("Ctrl+,");
    expect(overrides.get("help.shortcuts")).toBeNull();
    expect(shortcutConflicts({})).toEqual([]);
    expect(shortcutConflicts({ "sync.now": "d" })).toEqual([
      { binding: "D", actionIds: ["task.toggle_done", "sync.now"] },
    ]);
    expect(
      applicationPreferencesSchema.safeParse({
        ...defaultApplicationPreferences,
        shortcuts: { "sync.now": "D" },
      }).success,
    ).toBe(false);
    expect(
      applicationPreferencesSchema.safeParse({
        ...defaultApplicationPreferences,
        shortcuts: { "sync.now": "ctrl+shift+s" },
      }).success,
    ).toBe(true);
    expect(
      normalizeShortcutOverrides({
        "sync.now": "ctrl+shift+s",
        "help.shortcuts": null,
      }),
    ).toEqual({ "sync.now": "Ctrl+Shift+S", "help.shortcuts": null });
  });

  it("keeps default bindings unique and source keys unique", () => {
    const bound = shortcutActions.flatMap((action) =>
      action.defaultBinding === null ? [] : [action.defaultBinding],
    );
    expect(new Set(bound).size).toBe(bound.length);
    for (const binding of bound)
      expect(normalizeShortcutBinding(binding)).toBe(binding);
    const sourceKeys = shortcutActions.flatMap((action) =>
      action.sourceKey === null ? [] : [action.sourceKey],
    );
    expect(new Set(sourceKeys).size).toBe(sourceKeys.length);
  });
});
