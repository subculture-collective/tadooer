import {
  defaultFocusPreferences,
  focusPreferencesSchema,
  type FocusPreferences,
} from "@suite/contracts";
import {
  populated,
  type FieldDisposition,
} from "./super-productivity-schema.ts";

/**
 * Focus, idle, break and tracking-reminder configuration from Super
 * Productivity 19.1.0 `globalConfig` (issue #65, ADR 0029). Only the sections
 * listed here are read; the rest of `globalConfig` belongs to #67.
 *
 * For configuration, `applied` means the value becomes a focus preference
 * field on first import; `retained` means a populated value is reported by
 * name (`focus_preference_notice`) and left in the original export, because
 * Tadooer has no equivalent; `ignored` marks deprecated or derived keys that
 * carry no user data. Values are never copied into provenance: the export
 * stays the source, and the applied field names are recorded instead.
 */
export const superProductivityFocusConfigFields = {
  "pomodoro.duration": "applied",
  "pomodoro.breakDuration": "applied",
  "pomodoro.longerBreakDuration": "applied",
  "pomodoro.cyclesBeforeLongerBreak": "applied",
  "flowtime.isBreakEnabled": "applied",
  "flowtime.breakMode": "applied",
  "flowtime.breakPercentage": "applied",
  "flowtime.breakRules": "applied",
  // Deprecated in the source; kept only so old configs deserialize.
  "focusMode.isSkipPreparation": "ignored",
  "focusMode.isPlayTick": "ignored",
  "focusMode.isStartInBackground": "ignored",
  // Full-screen preparation and ambient sounds are not ported.
  "focusMode.isShowPreparation": "retained",
  "focusMode.focusModeSound": "retained",
  // Tadooer break intervals never count as task time (ADR 0010), so the
  // option to keep tracking during a break has no equivalent.
  "focusMode.isPauseTrackingDuringBreak": "retained",
  "focusMode.autoStartFocusOnPlay": "applied",
  // Pomodoro overtime (manual break start) is not ported.
  "focusMode.isManualBreakStart": "retained",
  "idle.isEnableIdleTimeTracking": "applied",
  "idle.minIdleTime": "applied",
  "idle.isOnlyOpenIdleWhenCurrentTask": "applied",
  "idle.isSuppressIdleDuringFocusMode": "applied",
  "takeABreak.isTakeABreakEnabled": "applied",
  "takeABreak.takeABreakMessage": "applied",
  "takeABreak.takeABreakMinWorkingTime": "applied",
  "takeABreak.takeABreakSnoozeTime": "applied",
  // Desktop-only effects and image lists stay with the desktop app.
  "takeABreak.isLockScreen": "retained",
  "takeABreak.isTimedFullScreenBlocker": "retained",
  "takeABreak.timedFullScreenBlockerDuration": "retained",
  "takeABreak.isFocusWindow": "retained",
  "takeABreak.motivationalImgs": "retained",
  "timeTracking.isTrackingReminderEnabled": "applied",
  "timeTracking.trackingReminderMinTime": "applied",
  // Tadooer delivers every reminder through the ntfy ledger when
  // notifications are enabled; per-channel switches have no equivalent.
  "timeTracking.isTrackingReminderNotify": "retained",
  "timeTracking.isTrackingReminderShowOnMobile": "retained",
  "timeTracking.isTrackingReminderFocusWindow": "retained",
  // Tadooer plays no sounds except the opt-in break-end tone.
  "sound.breakReminderSound": "retained",
  "sound.doneSound": "retained",
  "sound.trackTimeSound": "retained",
  "sound.isIncreaseDoneSoundPitch": "retained",
  "sound.volume": "retained",
} as const satisfies Record<string, FieldDisposition>;

type Source = Record<string, unknown>;
const object = (value: unknown): Source =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Source)
    : {};

const minute = 60_000;
/** Whole minutes from source milliseconds, at least one and at most `max`. */
const minutesOf = (value: unknown, max: number): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(max, Math.max(1, Math.round(value / minute)))
    : undefined;
const bool = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

export interface MappedFocusPreferences {
  readonly preferences: FocusPreferences;
  /** Dotted keys whose values were applied. */
  readonly fields: readonly string[];
}

/**
 * Overlays the mappable focus configuration on the Tadooer defaults. Returns
 * undefined when the export carries none of the reviewed sections. Retained
 * values and unusable applied values are reported through `notice`.
 */
export const mapSuperProductivityFocusPreferences = (
  globalConfig: unknown,
  notice: (sourceId: string, detail: string) => void,
): MappedFocusPreferences | undefined => {
  const config = object(globalConfig);
  const sections = [
    "pomodoro",
    "flowtime",
    "focusMode",
    "idle",
    "takeABreak",
    "timeTracking",
    "sound",
  ] as const;
  if (!sections.some((section) => populated(config[section]))) return undefined;
  const fields: string[] = [];
  const retained: string[] = [];
  const read = <T>(
    key: keyof typeof superProductivityFocusConfigFields,
    convert: (value: unknown) => T | undefined,
  ): T | undefined => {
    const [section, name] = key.split(".") as [string, string];
    const value = object(config[section])[name];
    const disposition = superProductivityFocusConfigFields[key];
    if (disposition === "retained") {
      if (populated(value)) retained.push(key);
      return undefined;
    }
    // An explicit false is user data when the Tadooer default is on.
    if (disposition !== "applied" || value === undefined || value === null)
      return undefined;
    if (typeof value !== "boolean" && !populated(value)) return undefined;
    const converted = convert(value);
    if (converted === undefined)
      notice(
        "globalConfig",
        `${key} is not a usable value and keeps the Tadooer default`,
      );
    else fields.push(key);
    return converted;
  };
  const defaults = defaultFocusPreferences;
  const rules = read("flowtime.breakRules", (value) => {
    if (!Array.isArray(value)) return undefined;
    const mapped = value.flatMap((entry) => {
      const rule = object(entry);
      const minMinutes =
        typeof rule.minDuration === "number" && rule.minDuration >= 0
          ? Math.round(rule.minDuration / minute)
          : undefined;
      const maxMinutes =
        rule.maxDuration === null ? null : minutesOf(rule.maxDuration, 1_440);
      const breakMinutes = minutesOf(rule.breakDuration, 240);
      return minMinutes === undefined ||
        maxMinutes === undefined ||
        breakMinutes === undefined ||
        (maxMinutes !== null && maxMinutes <= minMinutes)
        ? []
        : [
            {
              minMinutes: Math.min(1_440, minMinutes),
              maxMinutes,
              breakMinutes,
            },
          ];
    });
    return mapped.length === value.length && mapped.length <= 10
      ? mapped
      : undefined;
  });
  const breakMode = read("flowtime.breakMode", (value) =>
    value === "ratio" || value === "rule" ? value : undefined,
  );
  const candidate: FocusPreferences = {
    ...defaults,
    pomodoro: {
      workMinutes:
        read("pomodoro.duration", (v) => minutesOf(v, 240)) ??
        defaults.pomodoro.workMinutes,
      shortBreakMinutes:
        read("pomodoro.breakDuration", (v) => minutesOf(v, 120)) ??
        defaults.pomodoro.shortBreakMinutes,
      longBreakMinutes:
        read("pomodoro.longerBreakDuration", (v) => minutesOf(v, 240)) ??
        defaults.pomodoro.longBreakMinutes,
      cyclesBeforeLongBreak:
        read("pomodoro.cyclesBeforeLongerBreak", (v) =>
          typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 12
            ? v
            : undefined,
        ) ?? defaults.pomodoro.cyclesBeforeLongBreak,
    },
    flowtime: {
      breakEnabled:
        read("flowtime.isBreakEnabled", bool) ?? defaults.flowtime.breakEnabled,
      breakMode: breakMode ?? defaults.flowtime.breakMode,
      breakPercentage:
        read("flowtime.breakPercentage", (v) =>
          typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 100
            ? v
            : undefined,
        ) ?? defaults.flowtime.breakPercentage,
      breakRules: rules ?? defaults.flowtime.breakRules,
    },
    autoStartFocusOnTracking:
      read("focusMode.autoStartFocusOnPlay", bool) ??
      defaults.autoStartFocusOnTracking,
    idle: {
      enabled:
        read("idle.isEnableIdleTimeTracking", bool) ?? defaults.idle.enabled,
      minIdleMinutes:
        read("idle.minIdleTime", (v) => minutesOf(v, 120)) ??
        defaults.idle.minIdleMinutes,
      onlyWithTask:
        read("idle.isOnlyOpenIdleWhenCurrentTask", bool) ??
        defaults.idle.onlyWithTask,
      suppressInFocus:
        read("idle.isSuppressIdleDuringFocusMode", bool) ??
        defaults.idle.suppressInFocus,
    },
    takeABreak: {
      enabled:
        read("takeABreak.isTakeABreakEnabled", bool) ??
        defaults.takeABreak.enabled,
      minWorkingMinutes:
        read("takeABreak.takeABreakMinWorkingTime", (v) => minutesOf(v, 720)) ??
        defaults.takeABreak.minWorkingMinutes,
      snoozeMinutes:
        read("takeABreak.takeABreakSnoozeTime", (v) => minutesOf(v, 120)) ??
        defaults.takeABreak.snoozeMinutes,
      message:
        read("takeABreak.takeABreakMessage", (v) =>
          typeof v === "string" && v.trim() !== ""
            ? v.slice(0, 500)
            : undefined,
        ) ?? defaults.takeABreak.message,
    },
    trackingReminder: {
      enabled:
        read("timeTracking.isTrackingReminderEnabled", bool) ??
        defaults.trackingReminder.enabled,
      minMinutes:
        read("timeTracking.trackingReminderMinTime", (v) =>
          minutesOf(v, 240),
        ) ?? defaults.trackingReminder.minMinutes,
    },
  };
  // Retained keys are read for the report only.
  for (const key of Object.keys(
    superProductivityFocusConfigFields,
  ) as (keyof typeof superProductivityFocusConfigFields)[])
    if (superProductivityFocusConfigFields[key] === "retained")
      read(key, () => undefined);
  if (retained.length > 0)
    notice(
      "globalConfig",
      `${String(retained.length)} focus ${retained.length === 1 ? "setting has" : "settings have"} no Tadooer equivalent and ${retained.length === 1 ? "stays" : "stay"} in the export: ${retained.toSorted().join(", ")}`,
    );
  const parsed = focusPreferencesSchema.safeParse(candidate);
  if (!parsed.success) {
    notice(
      "globalConfig",
      "Focus settings could not be combined into a valid preference record and keep the Tadooer defaults",
    );
    return { preferences: defaults, fields: [] };
  }
  return { preferences: parsed.data, fields: fields.toSorted() };
};
