import { describe, expect, it } from "vitest";
import { applicationStartPages } from "@suite/contracts";
import { workspaceRoutes } from "./app/routes.ts";
import {
  bindingFromEvent,
  formatBinding,
  shortcutActionFor,
  shortcutGroups,
} from "./shortcuts.ts";

const key = (
  value: string,
  modifiers: Partial<{
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  }> = {},
  target: EventTarget | null = null,
) => ({
  key: value,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  target,
  ...modifiers,
});

describe("shortcuts (ADR 0030)", () => {
  it("every start page is a workspace route", () => {
    for (const page of applicationStartPages)
      expect(workspaceRoutes).toContain(page);
  });

  it("derives canonical bindings from key events", () => {
    expect(bindingFromEvent(key("k", { ctrlKey: true }))).toBe("Ctrl+K");
    expect(bindingFromEvent(key("k", { metaKey: true }))).toBe("Ctrl+K");
    expect(bindingFromEvent(key("A", { shiftKey: true }))).toBe("Shift+A");
    expect(bindingFromEvent(key("?", { shiftKey: true }))).toBe("?");
    expect(
      bindingFromEvent(key("ArrowUp", { ctrlKey: true, shiftKey: true })),
    ).toBe("Ctrl+Shift+ArrowUp");
    expect(bindingFromEvent(key("Shift", { shiftKey: true }))).toBeUndefined();
  });

  it("maps events to actions and ignores plain keys while typing", () => {
    expect(shortcutActionFor(key("k", { ctrlKey: true }), {})).toBe(
      "command_bar.open",
    );
    expect(shortcutActionFor(key("?", { shiftKey: true }), {})).toBe(
      "help.shortcuts",
    );
    expect(shortcutActionFor(key("d"), {})).toBe("task.toggle_done");
    expect(
      shortcutActionFor(key("d"), { "task.toggle_done": null }),
    ).toBeUndefined();
    expect(
      shortcutActionFor(key("d"), {
        "sync.now": "D",
        "task.toggle_done": null,
      }),
    ).toBe("sync.now");
    const input = { tagName: "INPUT" } as unknown as EventTarget;
    expect(shortcutActionFor(key("d", {}, input), {})).toBeUndefined();
    expect(
      shortcutActionFor(key("A", { shiftKey: true }, input), {}),
    ).toBeUndefined();
    expect(shortcutActionFor(key("k", { ctrlKey: true }, input), {})).toBe(
      "command_bar.open",
    );
  });

  it("formats bindings for display and groups actions", () => {
    expect(formatBinding("Ctrl+K", false)).toBe("Ctrl+K");
    expect(formatBinding("Ctrl+K", true)).toBe("⌘K");
    expect(formatBinding(null)).toBe("Not bound");
    expect(shortcutGroups().map(({ group }) => group)).toEqual([
      "Navigate",
      "Tasks",
      "Focus",
      "Workspace",
    ]);
  });
});
