import {
  normalizeShortcutBinding,
  resolveShortcutBindings,
  shortcutActions,
  type ShortcutActionId,
  type ShortcutOverrides,
} from "@suite/contracts";

/**
 * Keyboard shortcut runtime (ADR 0030). Bindings are canonical strings from
 * the contracts registry (`Ctrl+K`, `Shift+A`, `?`). `Ctrl` matches the
 * Control key and, on Apple devices, the Command key. Shortcuts without a
 * modifier are ignored while an input, textarea, select or editable element
 * has focus, so typing never triggers them.
 */

export interface ShortcutKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly target?: EventTarget | null;
}

/** Canonical binding for a key event, or undefined for a bare modifier. */
export const bindingFromEvent = (
  event: ShortcutKeyEvent,
): string | undefined => {
  if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return undefined;
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  // A shifted symbol ("?") already carries the shift; letters and named keys
  // keep it explicit so "Shift+A" and "A" stay distinct.
  if (event.shiftKey && (event.key.length !== 1 || /[a-z]/i.test(event.key)))
    parts.push("Shift");
  parts.push(event.key === " " ? "Space" : event.key);
  return normalizeShortcutBinding(parts.join("+"));
};

export const isEditableTarget = (
  target: EventTarget | null | undefined,
): boolean => {
  if (target === null || target === undefined || typeof target !== "object")
    return false;
  const element = target as { tagName?: unknown; isContentEditable?: unknown };
  return (
    element.isContentEditable === true ||
    (typeof element.tagName === "string" &&
      ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName))
  );
};

/** The action a key event triggers under the given overrides, if any. */
export const shortcutActionFor = (
  event: ShortcutKeyEvent,
  overrides: ShortcutOverrides,
): ShortcutActionId | undefined => {
  const binding = bindingFromEvent(event);
  if (binding === undefined) return undefined;
  if (!binding.includes("+") && isEditableTarget(event.target))
    return undefined;
  if (
    binding.startsWith("Shift+") &&
    binding.split("+").length === 2 &&
    isEditableTarget(event.target)
  )
    return undefined;
  for (const [id, bound] of resolveShortcutBindings(overrides))
    if (bound === binding) return id;
  return undefined;
};

/** Display form: "Ctrl+K" becomes "⌘K" on Apple devices, otherwise unchanged. */
export const formatBinding = (
  binding: string | null,
  applePlatform = typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.userAgent),
): string => {
  if (binding === null) return "Not bound";
  return applePlatform ? binding.replace("Ctrl+", "⌘") : binding;
};

export const shortcutGroups = (): readonly {
  readonly group: string;
  readonly actions: readonly (typeof shortcutActions)[number][];
}[] => {
  const groups = new Map<string, (typeof shortcutActions)[number][]>();
  for (const action of shortcutActions)
    groups.set(action.group, [...(groups.get(action.group) ?? []), action]);
  return [...groups].map(([group, actions]) => ({ group, actions }));
};
