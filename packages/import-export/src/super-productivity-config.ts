import {
  normalizeShortcutBinding,
  shortcutActions,
  shortcutConflicts,
  type ApplicationPreferences,
  type ShortcutActionId,
  type ShortcutOverrides,
} from "@suite/contracts";

/**
 * Super Productivity 19.1.0 `globalConfig` (issue #67, ADR 0030).
 *
 * Every section and field of `GlobalConfigState` has one disposition:
 *
 * - applied: copied into the Tadooer application preferences as is.
 * - transform: converted into a Tadooer setting (units, IDs, option names).
 * - excluded: never read for values and never stored. Credentials, sync
 *   provider configuration, desktop window and tray state, device paths,
 *   sounds, deprecated copies and transient bookkeeping.
 * - deferred: a user preference without a Tadooer equivalent yet; kept in
 *   the original export and reported with its owning issue.
 *
 * Mapped settings apply once, only while the owner has never saved the
 * corresponding preferences. Findings carry section names and counts, never
 * values. Configuration never blocks an import.
 */
export type ConfigFieldDisposition =
  "applied" | "transform" | "excluded" | "deferred";

export interface ConfigSection {
  readonly disposition: ConfigFieldDisposition;
  /** Issue that owns a deferred section, or the reason a section is excluded. */
  readonly note: string;
  readonly fields: Readonly<Record<string, ConfigFieldDisposition>>;
}

const all = (
  fields: readonly string[],
  disposition: ConfigFieldDisposition,
): Record<string, ConfigFieldDisposition> =>
  Object.fromEntries(fields.map((field) => [field, disposition]));

/** Super Productivity 19.1.0 KeyboardConfig keys with a Tadooer action. */
const mappedKeyboardKeys = new Map<string, ShortcutActionId>(
  shortcutActions.flatMap((action) =>
    action.sourceKey === null ? [] : [[action.sourceKey, action.id]],
  ),
);

const keyboardKeys = [
  "globalShowHide",
  "globalAddNote",
  "globalAddTask",
  "globalToggleTaskWidget",
  "globalToggleTaskStart",
  "toggleBacklog",
  "goToFocusMode",
  "goToWorkView",
  "goToTimeline",
  "goToScheduledView",
  "goToSettings",
  "addNewTask",
  "addNewProject",
  "showHelp",
  "showSearchBar",
  "addNewNote",
  "focusSideNav",
  "toggleSideNavMode",
  "openProjectNotes",
  "toggleTaskViewCustomizerPanel",
  "toggleIssuePanel",
  "zoomIn",
  "zoomOut",
  "zoomDefault",
  "triggerSync",
  "taskEditTitle",
  "taskToggleDetailPanelOpen",
  "taskOpenNotesPanel",
  "taskOpenNotesFullscreen",
  "taskOpenEstimationDialog",
  "taskToggleDone",
  "taskAddSubTask",
  "taskDuplicate",
  "taskAddAttachment",
  "taskMoveToProject",
  "taskOpenContextMenu",
  "taskDelete",
  "taskSchedule",
  "taskScheduleToday",
  "taskScheduleTomorrow",
  "taskScheduleNextWeek",
  "taskScheduleNextMonth",
  "taskScheduleDeadline",
  "taskUnschedule",
  "selectPreviousTask",
  "selectNextTask",
  "moveTaskUp",
  "moveTaskDown",
  "moveTaskToTop",
  "moveTaskToBottom",
  "moveToBacklog",
  "expandSubTasks",
  "collapseSubTasks",
  "togglePlay",
  "taskEditTags",
  "taskToggleSelect",
] as const;
/** OS-level desktop shortcuts and window zoom have no browser equivalent. */
const desktopKeyboardKeys = new Set([
  "globalShowHide",
  "globalAddNote",
  "globalAddTask",
  "globalToggleTaskWidget",
  "globalToggleTaskStart",
  "zoomIn",
  "zoomOut",
  "zoomDefault",
]);

export const superProductivityGlobalConfigSections = {
  appFeatures: {
    disposition: "deferred",
    note: "feature toggles; Tadooer navigation is fixed (#67 follow-up)",
    fields: all(
      [
        "isTimeTrackingEnabled",
        "isFocusModeEnabled",
        "isSchedulerEnabled",
        "isPlannerEnabled",
        "isBoardsEnabled",
        "isScheduleDayPanelEnabled",
        "isIssuesPanelEnabled",
        "isProjectNotesEnabled",
        "isSyncIconEnabled",
        "isSearchEnabled",
        "isDonatePageEnabled",
        "isHabitsEnabled",
        "isFinishDayEnabled",
      ],
      "deferred",
    ),
  },
  localization: {
    disposition: "applied",
    note: "language, first day of week and date/time locale",
    fields: {
      lng: "applied",
      firstDayOfWeek: "applied",
      dateTimeLocale: "transform",
    },
  },
  misc: {
    disposition: "applied",
    note: "start page and day start; desktop and wallpaper settings excluded",
    fields: {
      isConfirmBeforeExit: "excluded",
      isConfirmBeforeExitWithoutFinishDay: "excluded",
      isMinimizeToTray: "excluded",
      isLocalRestApiEnabled: "excluded",
      isCheckForUpdates: "excluded",
      // Deprecated hour-only copy of startOfNextDayTime.
      startOfNextDay: "excluded",
      // Planning preference dayStartsAt (ADR 0027) when it is an exact time.
      startOfNextDayTime: "transform",
      // Tadooer follows prefers-reduced-motion instead.
      isDisableAnimations: "excluded",
      isVerticalActionBar: "excluded",
      isDisableCelebration: "excluded",
      isShowProductivityTipLonger: "excluded",
      isTrayShowCurrentCountdown: "excluded",
      isUseCustomWindowTitleBar: "excluded",
      // A colour theme name. Dark/light mode is device-local in the source
      // (localStorage), so no export carries it.
      customTheme: "excluded",
      defaultStartPage: "transform",
      // Credential.
      unsplashApiKey: "excluded",
      backgroundImageDark: "excluded",
      backgroundImageLight: "excluded",
      backgroundOverlayOpacity: "excluded",
      backgroundImageBlur: "excluded",
      // Deprecated copies of the tasks section, migrated by the source.
      isConfirmBeforeTaskDelete: "excluded",
      isAutoAddWorkedOnToToday: "excluded",
      isAutMarkParentAsDone: "excluded",
      isTrayShowCurrentTask: "excluded",
      isTurnOffMarkdown: "excluded",
      defaultProjectId: "excluded",
      taskNotesTpl: "excluded",
      isOverlayIndicatorEnabled: "excluded",
      overlayIndicatorOpacity: "excluded",
    },
  },
  tasks: {
    disposition: "applied",
    note: "completion, deletion, Markdown and default project",
    fields: {
      isAutoMarkParentAsDone: "applied",
      isAutoAddWorkedOnToToday: "applied",
      isConfirmBeforeDelete: "applied",
      isTrayShowCurrent: "excluded",
      isMarkdownFormattingInNotesEnabled: "applied",
      defaultProjectId: "transform",
      // Capture notes template belongs to capture syntax (#90).
      notesTemplate: "deferred",
    },
  },
  shortSyntax: {
    disposition: "deferred",
    note: "capture syntax (#90)",
    fields: all(
      [
        "isEnableProject",
        "isEnableDue",
        "isEnableDeadline",
        "isEnableTag",
        "urlBehavior",
      ],
      "deferred",
    ),
  },
  evaluation: {
    disposition: "deferred",
    note: "finish-day ritual (#52)",
    fields: { isHideEvaluationSheet: "deferred" },
  },
  idle: {
    disposition: "deferred",
    note: "focus, idle and break preferences (#65)",
    fields: all(
      [
        "isEnableIdleTimeTracking",
        "minIdleTime",
        "isOnlyOpenIdleWhenCurrentTask",
        "isSuppressIdleDuringFocusMode",
      ],
      "deferred",
    ),
  },
  takeABreak: {
    disposition: "deferred",
    note: "focus, idle and break preferences (#65)",
    fields: all(
      [
        "isTakeABreakEnabled",
        "isLockScreen",
        "isTimedFullScreenBlocker",
        "timedFullScreenBlockerDuration",
        "isFocusWindow",
        "takeABreakMessage",
        "takeABreakMinWorkingTime",
        "takeABreakSnoozeTime",
        "motivationalImgs",
      ],
      "deferred",
    ),
  },
  pomodoro: {
    disposition: "deferred",
    note: "focus, idle and break preferences (#65)",
    fields: all(
      [
        "duration",
        "breakDuration",
        "longerBreakDuration",
        "cyclesBeforeLongerBreak",
      ],
      "deferred",
    ),
  },
  flowtime: {
    disposition: "deferred",
    note: "focus, idle and break preferences (#65)",
    fields: all(
      ["isBreakEnabled", "breakMode", "breakPercentage", "breakRules"],
      "deferred",
    ),
  },
  keyboard: {
    disposition: "applied",
    note: "bindings for actions Tadooer has; the rest stay in the export",
    fields: Object.fromEntries(
      keyboardKeys.map((key) => [
        key,
        desktopKeyboardKeys.has(key)
          ? "excluded"
          : mappedKeyboardKeys.has(key)
            ? "transform"
            : "deferred",
      ]),
    ),
  },
  localBackup: {
    disposition: "excluded",
    note: "desktop local backup files",
    fields: all(["isEnabled", "maxBackupFiles"], "excluded"),
  },
  sound: {
    disposition: "excluded",
    note: "device sounds; Tadooer plays none",
    fields: all(
      [
        "isIncreaseDoneSoundPitch",
        "doneSound",
        "breakReminderSound",
        "trackTimeSound",
        "volume",
      ],
      "excluded",
    ),
  },
  timeTracking: {
    disposition: "applied",
    note: "default estimates and estimate-exceeded notice; tracking reminders are #65",
    fields: {
      defaultEstimate: "transform",
      defaultEstimateSubTasks: "transform",
      isAutoStartNextTask: "deferred",
      isNotifyWhenTimeEstimateExceeded: "applied",
      isTrackingReminderEnabled: "deferred",
      isTrackingReminderShowOnMobile: "deferred",
      trackingReminderMinTime: "deferred",
      isTrackingReminderNotify: "deferred",
      isTrackingReminderFocusWindow: "deferred",
    },
  },
  reminder: {
    disposition: "applied",
    note: "default reminder option and due-date hour; the master switch stays an owner decision",
    fields: {
      isCountdownBannerEnabled: "excluded",
      countdownDuration: "excluded",
      defaultTaskRemindOption: "transform",
      // Enabling Tadooer reminders starts server delivery, so it is never imported.
      disableReminders: "excluded",
      isFocusWindow: "excluded",
      useAlarmStyleReminders: "excluded",
      notifyOnDueDate: "applied",
      dueDateNotificationHour: "applied",
    },
  },
  schedule: {
    disposition: "applied",
    note: "working hours and lunch break become planning preferences",
    fields: all(
      [
        "isWorkStartEndEnabled",
        "workStart",
        "workEnd",
        "isLunchBreakEnabled",
        "lunchBreakStart",
        "lunchBreakEnd",
      ],
      "transform",
    ),
  },
  dominaMode: {
    disposition: "excluded",
    note: "deprecated voice reminder",
    fields: all(
      ["isEnabled", "text", "interval", "volume", "voice"],
      "excluded",
    ),
  },
  focusMode: {
    disposition: "deferred",
    note: "focus, idle and break preferences (#65)",
    fields: all(
      [
        "isSkipPreparation",
        "isShowPreparation",
        "focusModeSound",
        "isPlayTick",
        "isPauseTrackingDuringBreak",
        "autoStartFocusOnPlay",
        "isStartInBackground",
        "isManualBreakStart",
      ],
      "deferred",
    ),
  },
  clipboardImages: {
    disposition: "excluded",
    note: "device path",
    fields: { imagePath: "excluded" },
  },
  sync: {
    disposition: "excluded",
    note: "sync provider configuration and credentials (#94)",
    fields: all(
      [
        "isEnabled",
        "isEncryptionEnabled",
        "isCompressionEnabled",
        "isUseSplitSyncFiles",
        "syncProvider",
        "syncInterval",
        "isManualSyncOnly",
        "encryptKey",
        "webDav",
        "superSync",
        "localFileSync",
        "nextcloud",
        "oneDrive",
      ],
      "excluded",
    ),
  },
  dailySummaryNote: {
    disposition: "applied",
    note: "daily summary note text",
    fields: { txt: "applied", lastUpdateDayStr: "excluded" },
  },
} as const satisfies Record<string, ConfigSection>;

export type GlobalConfigSectionName =
  keyof typeof superProductivityGlobalConfigSections;

/** `section.field` keys, for the parity manifest drift test. */
export const superProductivityGlobalConfigFields: Readonly<
  Record<string, ConfigFieldDisposition>
> = Object.fromEntries(
  Object.entries(superProductivityGlobalConfigSections).flatMap(
    ([section, { fields }]) =>
      Object.entries(fields).map(([field, disposition]) => [
        `${section}.${field}`,
        disposition,
      ]),
  ),
);

type Source = Record<string, unknown>;
const object = (value: unknown): Source =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Source)
    : {};
const isPresent = (value: unknown): boolean =>
  value !== undefined && value !== null;

export interface SuperProductivityPlanningPatch {
  readonly workdayStart?: string;
  readonly workdayEnd?: string;
  readonly breakStart?: string | null;
  readonly breakEnd?: string | null;
  readonly dayStartsAt?: string;
}

export interface SuperProductivityConfigMapping {
  readonly preferences: Partial<
    Omit<ApplicationPreferences, "defaultProjectId">
  > & {
    readonly defaultProjectSourceId?: string | null;
  };
  readonly planning: SuperProductivityPlanningPatch;
  readonly counts: {
    readonly applied: number;
    readonly shortcuts: number;
    readonly planning: number;
    readonly excluded: number;
    readonly retained: number;
  };
}

export interface ConfigFinding {
  readonly code:
    "config_field_excluded" | "config_field_retained" | "config_applied";
  readonly sourceId: string | null;
  readonly detail: string;
}

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

/** "9:00" or "09:00" to "09:00"; anything else undefined. */
const clockTime = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
};

const wholeMinutes = (value: unknown): number | null | undefined => {
  if (value === null || value === undefined || value === 0) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    return undefined;
  if (value < 0 || value % 60_000 !== 0) return undefined;
  const minutes = value / 60_000;
  return minutes >= 1 && minutes <= 720 ? minutes : undefined;
};

const remindOptions: Readonly<
  Record<string, ApplicationPreferences["defaultTaskReminder"]>
> = {
  DoNotRemind: { kind: "none" },
  AtStart: { kind: "before_start", minutes: 0 },
  m5: { kind: "before_start", minutes: 5 },
  m10: { kind: "before_start", minutes: 10 },
  m15: { kind: "before_start", minutes: 15 },
  m30: { kind: "before_start", minutes: 30 },
  h1: { kind: "before_start", minutes: 60 },
};

/**
 * Maps `globalConfig` into Tadooer preferences and reports the rest. Values
 * of excluded fields are never read; findings carry counts and field names.
 */
export const mapSuperProductivityGlobalConfig = (
  globalConfig: unknown,
  finding: (finding: ConfigFinding) => void,
): SuperProductivityConfigMapping | undefined => {
  if (!isPresent(globalConfig)) return undefined;
  const config = object(globalConfig);
  const preferences: Record<string, unknown> = {};
  const planning: Record<string, unknown> = {};
  const shortcuts: Record<string, string | null> = {};
  const counts = {
    applied: 0,
    shortcuts: 0,
    planning: 0,
    excluded: 0,
    retained: 0,
  };
  const retained = (sourceId: string, detail: string, count = 1) => {
    counts.retained += count;
    finding({ code: "config_field_retained", sourceId, detail });
  };
  const excluded = (sourceId: string, detail: string, count: number) => {
    counts.excluded += count;
    finding({ code: "config_field_excluded", sourceId, detail });
  };
  const apply = (key: keyof ApplicationPreferences, value: unknown) => {
    preferences[key] = value;
    counts.applied += 1;
  };
  const unusable = (section: string, field: string) =>
    retained(
      `globalConfig.${section}`,
      `globalConfig.${section}.${field} is not a usable value and is kept in the original export`,
    );

  for (const [name, value] of Object.entries(config)) {
    if (!Object.hasOwn(superProductivityGlobalConfigSections, name)) {
      const size = Object.keys(object(value)).length;
      retained(
        `globalConfig.${name}`,
        `globalConfig.${name} is not a reviewed Super Productivity 19.1.0 section; ${plural(size, "field")} kept in the original export`,
        Math.max(size, 1),
      );
      continue;
    }
    const section =
      superProductivityGlobalConfigSections[name as GlobalConfigSectionName];
    const fields = object(value);
    if (section.disposition === "excluded") {
      // Never inspect values: this is where credentials live.
      const size = Object.keys(fields).length;
      if (size > 0)
        excluded(
          `globalConfig.${name}`,
          `globalConfig.${name}: ${plural(size, "field")} excluded (${section.note}); nothing is stored`,
          size,
        );
      continue;
    }
    if (section.disposition === "deferred") {
      const size = Object.keys(fields).filter((field) =>
        isPresent(fields[field]),
      ).length;
      if (size > 0)
        retained(
          `globalConfig.${name}`,
          `globalConfig.${name}: ${plural(size, "field")} kept in the original export; ${section.note}`,
          size,
        );
      continue;
    }
    const unknown: string[] = [];
    let excludedCount = 0;
    let deferredCount = 0;
    for (const [field, raw] of Object.entries(fields)) {
      const disposition = (
        section.fields as Readonly<Record<string, ConfigFieldDisposition>>
      )[field];
      if (disposition === undefined) {
        if (name === "keyboard" && field.startsWith("plugin_")) excludedCount++;
        else unknown.push(field);
        continue;
      }
      if (disposition === "excluded") {
        if (isPresent(raw)) excludedCount++;
        continue;
      }
      if (disposition === "deferred") {
        if (isPresent(raw)) deferredCount++;
        continue;
      }
      if (name === "keyboard") {
        const actionId = mappedKeyboardKeys.get(field);
        if (actionId === undefined) continue;
        if (raw === null) {
          shortcuts[actionId] = null;
          counts.shortcuts += 1;
        } else if (typeof raw === "string") {
          const binding = normalizeShortcutBinding(raw);
          if (binding === undefined) unusable(name, field);
          else {
            shortcuts[actionId] = binding;
            counts.shortcuts += 1;
          }
        } else unusable(name, field);
        continue;
      }
      if (!isPresent(raw)) continue;
      const key = `${name}.${field}`;
      switch (key) {
        case "localization.lng":
          if (
            typeof raw === "string" &&
            /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(raw)
          )
            apply("language", raw);
          else unusable(name, field);
          break;
        case "localization.firstDayOfWeek":
          if (
            typeof raw === "number" &&
            Number.isInteger(raw) &&
            raw >= 0 &&
            raw <= 6
          )
            apply("firstDayOfWeek", raw);
          else unusable(name, field);
          break;
        case "localization.dateTimeLocale": {
          let canonical: string | undefined;
          try {
            canonical =
              typeof raw === "string"
                ? Intl.getCanonicalLocales(raw)[0]
                : undefined;
          } catch {
            canonical = undefined;
          }
          if (canonical === undefined) unusable(name, field);
          else apply("dateTimeLocale", canonical);
          break;
        }
        case "misc.startOfNextDayTime": {
          const time = clockTime(raw);
          if (time === undefined) unusable(name, field);
          else {
            planning.dayStartsAt = time;
            counts.planning += 1;
          }
          break;
        }
        case "misc.defaultStartPage":
          if (raw === 0) apply("defaultStartPage", "today");
          else if (raw === 1) apply("defaultStartPage", "inbox");
          else if (raw === 2 || raw === 3) apply("defaultStartPage", "planner");
          else
            retained(
              `globalConfig.${name}`,
              raw === 4
                ? "globalConfig.misc.defaultStartPage opens boards, which Tadooer does not have yet (#63); kept in the original export"
                : "globalConfig.misc.defaultStartPage opens a project page, which Tadooer does not have; kept in the original export",
            );
          break;
        case "tasks.isAutoMarkParentAsDone":
        case "tasks.isAutoAddWorkedOnToToday":
        case "tasks.isConfirmBeforeDelete":
        case "tasks.isMarkdownFormattingInNotesEnabled":
        case "timeTracking.isNotifyWhenTimeEstimateExceeded":
        case "reminder.notifyOnDueDate": {
          const target: Record<string, keyof ApplicationPreferences> = {
            "tasks.isAutoMarkParentAsDone": "autoMarkParentDone",
            "tasks.isAutoAddWorkedOnToToday": "autoAddWorkedOnToToday",
            "tasks.isConfirmBeforeDelete": "confirmBeforeDelete",
            "tasks.isMarkdownFormattingInNotesEnabled": "markdownInNotes",
            "timeTracking.isNotifyWhenTimeEstimateExceeded":
              "notifyWhenEstimateExceeded",
            "reminder.notifyOnDueDate": "notifyOnDueDate",
          };
          const preference = target[key];
          if (typeof raw === "boolean" && preference !== undefined)
            apply(preference, raw);
          else unusable(name, field);
          break;
        }
        case "tasks.defaultProjectId":
          if (raw === false) break;
          if (typeof raw === "string" && raw !== "") {
            preferences.defaultProjectSourceId = raw;
            counts.applied += 1;
          } else unusable(name, field);
          break;
        case "timeTracking.defaultEstimate":
        case "timeTracking.defaultEstimateSubTasks": {
          const minutes = wholeMinutes(raw);
          if (minutes === undefined) unusable(name, field);
          else
            apply(
              field === "defaultEstimate"
                ? "defaultEstimateMinutes"
                : "defaultChildEstimateMinutes",
              minutes,
            );
          break;
        }
        case "reminder.defaultTaskRemindOption": {
          const option =
            typeof raw === "string" ? remindOptions[raw] : undefined;
          if (option === undefined) unusable(name, field);
          else apply("defaultTaskReminder", option);
          break;
        }
        case "reminder.dueDateNotificationHour":
          if (
            typeof raw === "number" &&
            Number.isInteger(raw) &&
            raw >= 0 &&
            raw <= 23
          )
            apply("dueDateNotificationHour", raw);
          else unusable(name, field);
          break;
        case "dailySummaryNote.txt":
          if (typeof raw === "string" && raw.length <= 10_000)
            apply("dailySummaryNote", raw);
          else unusable(name, field);
          break;
        case "schedule.isWorkStartEndEnabled":
        case "schedule.workStart":
        case "schedule.workEnd":
        case "schedule.isLunchBreakEnabled":
        case "schedule.lunchBreakStart":
        case "schedule.lunchBreakEnd":
          // Handled together below.
          break;
        default:
          unusable(name, field);
      }
    }
    if (name === "schedule") {
      const enabled = fields.isWorkStartEndEnabled === true;
      const start = clockTime(fields.workStart);
      const end = clockTime(fields.workEnd);
      if (enabled && start !== undefined && end !== undefined && start < end) {
        planning.workdayStart = start;
        planning.workdayEnd = end;
        counts.planning += 2;
        const lunch = fields.isLunchBreakEnabled === true;
        const lunchStart = clockTime(fields.lunchBreakStart);
        const lunchEnd = clockTime(fields.lunchBreakEnd);
        if (
          lunch &&
          lunchStart !== undefined &&
          lunchEnd !== undefined &&
          lunchStart < lunchEnd &&
          lunchStart >= start &&
          lunchEnd <= end
        ) {
          planning.breakStart = lunchStart;
          planning.breakEnd = lunchEnd;
          counts.planning += 2;
        } else if (lunch) unusable(name, "lunchBreakStart");
        else {
          planning.breakStart = null;
          planning.breakEnd = null;
        }
      } else if (enabled) unusable(name, "workStart");
    }
    if (unknown.length > 0)
      retained(
        `globalConfig.${name}`,
        `globalConfig.${name}: ${plural(unknown.length, "unreviewed field")} (${unknown.join(", ")}) kept in the original export`,
        unknown.length,
      );
    if (excludedCount > 0)
      excluded(
        `globalConfig.${name}`,
        `globalConfig.${name}: ${plural(excludedCount, "field")} excluded (desktop, deprecated or transient); nothing is stored`,
        excludedCount,
      );
    if (deferredCount > 0)
      retained(
        `globalConfig.${name}`,
        `globalConfig.${name}: ${plural(deferredCount, "field")} kept in the original export; ${section.note}`,
        deferredCount,
      );
  }

  // Imported bindings must not collide with each other or with defaults.
  const overrides: Record<string, string | null> = {};
  for (const [actionId, binding] of Object.entries(shortcuts)) {
    const candidate = {
      ...overrides,
      [actionId]: binding,
    } as ShortcutOverrides;
    if (shortcutConflicts(candidate).length === 0)
      overrides[actionId] = binding;
    else {
      counts.shortcuts -= 1;
      retained(
        "globalConfig.keyboard",
        `globalConfig.keyboard: the binding for ${actionId} collides with another shortcut and is kept in the original export`,
      );
    }
  }
  if (Object.keys(overrides).length > 0) {
    preferences.shortcuts = overrides;
  }

  if (counts.applied + counts.shortcuts + counts.planning === 0)
    return undefined;
  finding({
    code: "config_applied",
    sourceId: null,
    detail: `globalConfig: ${plural(counts.applied, "application setting")}, ${plural(counts.shortcuts, "shortcut binding")} and ${plural(counts.planning, "planning setting")} apply once, only while the owner has never saved those preferences`,
  });
  return {
    preferences,
    planning,
    counts,
  };
};
