import { z } from "zod";
import { taskStartReminderSchema } from "./task-planning.ts";

/**
 * Application preferences and keyboard shortcuts (issue #67, ADR 0030).
 *
 * One owner-scoped, revisioned record holds the safe application settings
 * that Super Productivity keeps in `globalConfig`: locale, theme, capture
 * defaults, completion behaviour, reminder defaults, the daily summary note
 * and the owner's shortcut bindings. Sync provider configuration, desktop
 * window state and credentials are never part of it.
 */

export const applicationThemeSchema = z.enum(["dark", "light", "system"]);
export type ApplicationTheme = z.infer<typeof applicationThemeSchema>;

/** Workspace routes an owner may open first; checked against the web routes. */
export const applicationStartPages = [
  "today",
  "inbox",
  "planner",
  "tasks",
  "history",
  "worklog",
  "counters",
  "reuse",
  "habits",
  "connections",
  "settings",
] as const;
export const applicationStartPageSchema = z.enum(applicationStartPages);
export type ApplicationStartPage = z.infer<typeof applicationStartPageSchema>;

/**
 * Lower-case language code as Super Productivity stores it (`en`, `pt-br`).
 * Only English is rendered today; the code is kept so a later translation
 * layer can honour it without another migration.
 */
export const languageCodeSchema = z
  .string()
  .regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/, "Use a lower-case language code");

/** BCP 47 locale for date and time formatting, canonicalized by Intl. */
export const dateTimeLocaleSchema = z
  .string()
  .min(2)
  .max(35)
  .refine(
    (tag) => {
      try {
        return Intl.getCanonicalLocales(tag).length === 1;
      } catch {
        return false;
      }
    },
    { message: "Use a valid BCP 47 locale such as en-US" },
  );

export const estimateMinutesSchema = z.number().int().min(1).max(720);

const modifierOrder = ["Ctrl", "Alt", "Shift", "Meta"] as const;
type Modifier = (typeof modifierOrder)[number];
const namedKeys = new Set([
  "Enter",
  "Escape",
  "Space",
  "Tab",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  ...Array.from({ length: 12 }, (_, index) => `F${String(index + 1)}`),
]);
const modifierAliases: Readonly<Record<string, Modifier>> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  super: "Meta",
};

/**
 * Canonical form of a binding: modifiers in Ctrl, Alt, Shift, Meta order, then
 * one key. A key is a single printable character (letters upper-cased) or a
 * named key. Returns undefined for anything else. `Ctrl+K`, `Shift+A`, `?`,
 * `Ctrl++` and `Ctrl+Shift+ArrowUp` are valid.
 */
export const normalizeShortcutBinding = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  // A trailing "+" is the plus key itself (Super Productivity writes "Ctrl++").
  const plusKey = trimmed === "+" || trimmed.endsWith("++");
  const key = plusKey ? "+" : trimmed.slice(trimmed.lastIndexOf("+") + 1);
  const head = plusKey
    ? trimmed.slice(0, -1)
    : trimmed.slice(0, trimmed.lastIndexOf("+") + 1);
  const modifiers = new Set<Modifier>();
  for (const part of head.split("+").filter((part) => part !== "")) {
    const modifier = modifierAliases[part.toLowerCase()];
    if (modifier === undefined) return undefined;
    modifiers.add(modifier);
  }
  const named =
    key.toLowerCase() === "esc"
      ? "Escape"
      : [...namedKeys].find((n) => n.toLowerCase() === key.toLowerCase());
  const canonicalKey =
    key.length === 1 ? (key === " " ? "Space" : key.toUpperCase()) : named;
  if (canonicalKey === undefined) return undefined;
  return [...modifierOrder.filter((m) => modifiers.has(m)), canonicalKey].join(
    "+",
  );
};

/**
 * A binding as written; the record stores its canonical form (see
 * `normalizeShortcutOverrides`). A refine keeps the schema representable in
 * JSON Schema for the MCP catalog.
 */
export const shortcutBindingSchema = z
  .string()
  .max(40)
  .refine((value) => normalizeShortcutBinding(value) !== undefined, {
    message: "Use modifiers (Ctrl, Alt, Shift, Meta) plus one key",
  });

export interface ShortcutAction {
  readonly id: string;
  readonly label: string;
  readonly group: "Navigate" | "Tasks" | "Focus" | "Workspace";
  readonly defaultBinding: string | null;
  /** Super Productivity 19.1.0 `keyboard` key with the same meaning. */
  readonly sourceKey: string | null;
}

/** Every bindable action with its default. Runtime handlers live in the web app. */
export const shortcutActions = [
  {
    id: "navigate.today",
    label: "Go to Today",
    group: "Navigate",
    defaultBinding: "W",
    sourceKey: "goToWorkView",
  },
  {
    id: "navigate.inbox",
    label: "Go to Inbox",
    group: "Navigate",
    defaultBinding: "Shift+I",
    sourceKey: null,
  },
  {
    id: "navigate.planner",
    label: "Go to Planner",
    group: "Navigate",
    defaultBinding: "Shift+T",
    sourceKey: "goToTimeline",
  },
  {
    id: "navigate.tasks",
    label: "Go to Tasks",
    group: "Navigate",
    defaultBinding: "Shift+L",
    sourceKey: null,
  },
  {
    id: "navigate.history",
    label: "Go to History",
    group: "Navigate",
    defaultBinding: null,
    sourceKey: null,
  },
  {
    id: "navigate.worklog",
    label: "Go to Worklog",
    group: "Navigate",
    defaultBinding: null,
    sourceKey: null,
  },
  {
    id: "navigate.counters",
    label: "Go to Counters",
    group: "Navigate",
    defaultBinding: null,
    sourceKey: null,
  },
  {
    id: "navigate.reuse",
    label: "Go to Reuse",
    group: "Navigate",
    defaultBinding: null,
    sourceKey: null,
  },
  {
    id: "navigate.habits",
    label: "Go to Habits",
    group: "Navigate",
    defaultBinding: null,
    sourceKey: null,
  },
  {
    id: "navigate.connections",
    label: "Go to Connections",
    group: "Navigate",
    defaultBinding: null,
    sourceKey: null,
  },
  {
    id: "navigate.settings",
    label: "Go to Settings",
    group: "Navigate",
    defaultBinding: null,
    sourceKey: "goToSettings",
  },
  {
    id: "task.add",
    label: "Add a task",
    group: "Tasks",
    defaultBinding: "Shift+A",
    sourceKey: "addNewTask",
  },
  {
    id: "task.toggle_done",
    label: "Complete or reopen the selected task",
    group: "Tasks",
    defaultBinding: "D",
    sourceKey: "taskToggleDone",
  },
  {
    id: "focus.toggle",
    label: "Start focus on the selected task, or finish the running session",
    group: "Focus",
    defaultBinding: "Y",
    sourceKey: "togglePlay",
  },
  {
    id: "command_bar.open",
    label: "Open the command bar",
    group: "Workspace",
    defaultBinding: "Ctrl+K",
    sourceKey: "showSearchBar",
  },
  {
    id: "help.shortcuts",
    label: "Show keyboard shortcuts",
    group: "Workspace",
    defaultBinding: "?",
    sourceKey: "showHelp",
  },
  {
    id: "sync.now",
    label: "Sync now",
    group: "Workspace",
    defaultBinding: null,
    sourceKey: "triggerSync",
  },
] as const satisfies readonly ShortcutAction[];

export type ShortcutActionId = (typeof shortcutActions)[number]["id"];
export const shortcutActionIds = shortcutActions.map((action) => action.id) as [
  ShortcutActionId,
  ...ShortcutActionId[],
];
export const shortcutActionIdSchema = z.enum(shortcutActionIds);

/** Owner overrides only; an absent action keeps its default, null unbinds it. */
export const shortcutOverridesSchema = z.partialRecord(
  shortcutActionIdSchema,
  shortcutBindingSchema.nullable(),
);
export type ShortcutOverrides = z.infer<typeof shortcutOverridesSchema>;

/** Canonical form of every override; invalid bindings are dropped. */
export const normalizeShortcutOverrides = (
  overrides: ShortcutOverrides,
): ShortcutOverrides => {
  const normalized: Record<string, string | null> = {};
  for (const [id, binding] of Object.entries(overrides)) {
    if (binding === null) normalized[id] = null;
    else {
      const canonical = normalizeShortcutBinding(binding);
      if (canonical !== undefined) normalized[id] = canonical;
    }
  }
  return normalized;
};

/** Effective binding per action after overrides. */
export const resolveShortcutBindings = (
  overrides: ShortcutOverrides,
): ReadonlyMap<ShortcutActionId, string | null> =>
  new Map(
    shortcutActions.map((action) => [
      action.id,
      Object.hasOwn(overrides, action.id)
        ? (overrides[action.id] ?? null)
        : action.defaultBinding,
    ]),
  );

export interface ShortcutConflict {
  readonly binding: string;
  readonly actionIds: readonly ShortcutActionId[];
}

/** Two actions with the same effective binding cannot both fire. */
export const shortcutConflicts = (
  overrides: ShortcutOverrides,
): readonly ShortcutConflict[] => {
  const byBinding = new Map<string, ShortcutActionId[]>();
  for (const [id, bound] of resolveShortcutBindings(overrides)) {
    if (bound === null) continue;
    const binding = normalizeShortcutBinding(bound) ?? bound;
    byBinding.set(binding, [...(byBinding.get(binding) ?? []), id]);
  }
  return [...byBinding]
    .filter(([, ids]) => ids.length > 1)
    .map(([binding, actionIds]) => ({ binding, actionIds }));
};

export const applicationPreferencesSchema = z
  .object({
    theme: applicationThemeSchema,
    language: languageCodeSchema,
    dateTimeLocale: dateTimeLocaleSchema,
    /** 0 = Sunday … 6 = Saturday. */
    firstDayOfWeek: z.number().int().min(0).max(6),
    defaultStartPage: applicationStartPageSchema,
    /** Project new captures join; must be an active project of the owner. */
    defaultProjectId: z.uuid().nullable(),
    confirmBeforeDelete: z.boolean(),
    markdownInNotes: z.boolean(),
    /** ADR 0018 exception: completing the last open child completes the parent. */
    autoMarkParentDone: z.boolean(),
    autoAddWorkedOnToToday: z.boolean(),
    defaultEstimateMinutes: estimateMinutesSchema.nullable(),
    defaultChildEstimateMinutes: estimateMinutesSchema.nullable(),
    notifyWhenEstimateExceeded: z.boolean(),
    /** What a task's `default` start reminder means (ADR 0020). */
    defaultTaskReminder: taskStartReminderSchema,
    notifyOnDueDate: z.boolean(),
    dueDateNotificationHour: z.number().int().min(0).max(23),
    dailySummaryNote: z.string().max(10_000),
    shortcuts: shortcutOverridesSchema,
  })
  .strict()
  .refine(
    (preferences) => shortcutConflicts(preferences.shortcuts).length === 0,
    {
      message: "Two shortcuts share one key binding",
      path: ["shortcuts"],
    },
  );
export type ApplicationPreferences = z.infer<
  typeof applicationPreferencesSchema
>;

export const defaultApplicationPreferences: ApplicationPreferences = {
  theme: "dark",
  language: "en",
  dateTimeLocale: "en-US",
  firstDayOfWeek: 1,
  defaultStartPage: "today",
  defaultProjectId: null,
  confirmBeforeDelete: true,
  markdownInNotes: true,
  autoMarkParentDone: false,
  autoAddWorkedOnToToday: true,
  defaultEstimateMinutes: null,
  defaultChildEstimateMinutes: null,
  notifyWhenEstimateExceeded: true,
  defaultTaskReminder: { kind: "default" },
  notifyOnDueDate: true,
  dueDateNotificationHour: 9,
  dailySummaryNote: "",
  shortcuts: {},
};

export const applicationPreferenceSnapshotSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    preferences: applicationPreferencesSchema,
  })
  .strict();
export type ApplicationPreferenceSnapshot = z.infer<
  typeof applicationPreferenceSnapshotSchema
>;

export const applicationPreferenceMutationInputSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    preferences: applicationPreferencesSchema,
  })
  .strict();
export type ApplicationPreferenceMutationInput = z.infer<
  typeof applicationPreferenceMutationInputSchema
>;
