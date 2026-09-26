import { describe, expect, it } from "vitest";
import { defaultFocusPreferences } from "@suite/contracts";
import { prepareSuperProductivityImport } from "./super-productivity-apply.ts";
import {
  mapSuperProductivityFocusPreferences,
  superProductivityFocusConfigFields,
} from "./super-productivity-focus.ts";

const minute = 60_000;
const notices: string[] = [];
const notice = (sourceId: string, detail: string) => {
  notices.push(`${sourceId}: ${detail}`);
};

const sourceConfig = {
  pomodoro: {
    duration: 50 * minute,
    breakDuration: 10 * minute,
    longerBreakDuration: 20 * minute,
    cyclesBeforeLongerBreak: 3,
  },
  flowtime: {
    isBreakEnabled: true,
    breakMode: "rule",
    breakPercentage: 25,
    breakRules: [
      { minDuration: 0, maxDuration: 30 * minute, breakDuration: 5 * minute },
      {
        minDuration: 30 * minute,
        maxDuration: null,
        breakDuration: 12 * minute,
      },
    ],
  },
  focusMode: {
    isSkipPreparation: false,
    isShowPreparation: true,
    focusModeSound: "tick",
    isPauseTrackingDuringBreak: true,
    autoStartFocusOnPlay: true,
    isManualBreakStart: false,
  },
  idle: {
    isEnableIdleTimeTracking: true,
    minIdleTime: 90_000,
    isOnlyOpenIdleWhenCurrentTask: false,
    isSuppressIdleDuringFocusMode: true,
  },
  takeABreak: {
    isTakeABreakEnabled: true,
    isLockScreen: true,
    isTimedFullScreenBlocker: false,
    timedFullScreenBlockerDuration: 8000,
    isFocusWindow: false,
    takeABreakMessage: "Up for ${duration}. Walk!",
    takeABreakMinWorkingTime: 45 * minute,
    takeABreakSnoozeTime: 10 * minute,
    motivationalImgs: ["https://example.test/a.jpg"],
  },
  timeTracking: {
    defaultEstimate: 0,
    isTrackingReminderEnabled: true,
    trackingReminderMinTime: 8 * minute,
    isTrackingReminderNotify: true,
  },
  sound: {
    volume: 75,
    isIncreaseDoneSoundPitch: true,
    doneSound: "ding-small-bell.mp3",
    breakReminderSound: null,
  },
};

describe("Super Productivity focus configuration (ADR 0029)", () => {
  it("overlays the applied fields on the defaults, rounds to minutes and reports retained keys", () => {
    notices.length = 0;
    const mapped = mapSuperProductivityFocusPreferences(sourceConfig, notice);
    expect(mapped?.preferences).toEqual({
      ...defaultFocusPreferences,
      pomodoro: {
        workMinutes: 50,
        shortBreakMinutes: 10,
        longBreakMinutes: 20,
        cyclesBeforeLongBreak: 3,
      },
      flowtime: {
        breakEnabled: true,
        breakMode: "rule",
        breakPercentage: 25,
        breakRules: [
          { minMinutes: 0, maxMinutes: 30, breakMinutes: 5 },
          { minMinutes: 30, maxMinutes: null, breakMinutes: 12 },
        ],
      },
      autoStartFocusOnTracking: true,
      idle: {
        enabled: true,
        minIdleMinutes: 2,
        onlyWithTask: false,
        suppressInFocus: true,
      },
      takeABreak: {
        enabled: true,
        minWorkingMinutes: 45,
        snoozeMinutes: 10,
        message: "Up for ${duration}. Walk!",
      },
      trackingReminder: { enabled: true, minMinutes: 8 },
    });
    expect(mapped?.fields).toEqual([
      "flowtime.breakMode",
      "flowtime.breakPercentage",
      "flowtime.breakRules",
      "flowtime.isBreakEnabled",
      "focusMode.autoStartFocusOnPlay",
      "idle.isEnableIdleTimeTracking",
      "idle.isOnlyOpenIdleWhenCurrentTask",
      "idle.isSuppressIdleDuringFocusMode",
      "idle.minIdleTime",
      "pomodoro.breakDuration",
      "pomodoro.cyclesBeforeLongerBreak",
      "pomodoro.duration",
      "pomodoro.longerBreakDuration",
      "takeABreak.isTakeABreakEnabled",
      "takeABreak.takeABreakMessage",
      "takeABreak.takeABreakMinWorkingTime",
      "takeABreak.takeABreakSnoozeTime",
      "timeTracking.isTrackingReminderEnabled",
      "timeTracking.trackingReminderMinTime",
    ]);
    expect(notices).toEqual([
      "globalConfig: 10 focus settings have no Tadooer equivalent and stay in the export: focusMode.focusModeSound, focusMode.isPauseTrackingDuringBreak, focusMode.isShowPreparation, sound.doneSound, sound.isIncreaseDoneSoundPitch, sound.volume, takeABreak.isLockScreen, takeABreak.motivationalImgs, takeABreak.timedFullScreenBlockerDuration, timeTracking.isTrackingReminderNotify",
    ]);
    // Every reviewed key has exactly one disposition.
    expect(
      Object.values(superProductivityFocusConfigFields).every((value) =>
        ["applied", "retained", "ignored"].includes(value),
      ),
    ).toBe(true);
  });

  it("keeps the default for unusable values and returns nothing without focus sections", () => {
    notices.length = 0;
    const mapped = mapSuperProductivityFocusPreferences(
      {
        pomodoro: { duration: -5, cyclesBeforeLongerBreak: 40 },
        flowtime: { breakMode: "sometimes" },
        idle: { minIdleTime: 30 * 60 * 60 * 1000 },
      },
      notice,
    );
    expect(mapped?.preferences).toMatchObject({
      pomodoro: { workMinutes: 25, cyclesBeforeLongBreak: 4 },
      flowtime: { breakMode: "ratio" },
      // Clamped to the largest allowed value.
      idle: { minIdleMinutes: 120 },
    });
    expect(mapped?.fields).toEqual(["idle.minIdleTime"]);
    expect(notices).toEqual([
      "globalConfig: flowtime.breakMode is not a usable value and keeps the Tadooer default",
      "globalConfig: pomodoro.duration is not a usable value and keeps the Tadooer default",
      "globalConfig: pomodoro.cyclesBeforeLongerBreak is not a usable value and keeps the Tadooer default",
    ]);
    expect(
      mapSuperProductivityFocusPreferences(
        { misc: { startOfNextDayTime: "03:00" } },
        notice,
      ),
    ).toBeUndefined();
    expect(
      mapSuperProductivityFocusPreferences(undefined, notice),
    ).toBeUndefined();
  });

  it("carries the mapped preferences through the import preview without blocking", () => {
    const created = 1758000000000;
    const { report, focusPreferences } = prepareSuperProductivityImport(
      JSON.stringify({
        task: {
          ids: ["t1"],
          entities: { t1: { id: "t1", title: "One", created } },
        },
        globalConfig: sourceConfig,
      }),
      { timeZone: "America/Chicago", today: "2026-09-24" },
    );
    expect(report.canApply).toBe(true);
    expect(focusPreferences?.preferences.pomodoro.workMinutes).toBe(50);
    expect(focusPreferences?.fields).toHaveLength(19);
    const findings = report.issues.filter(
      ({ code }) => code === "focus_preference_notice",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      sourceId: "globalConfig",
      blocking: false,
    });
    // globalConfig is applied per field (#65, #67), never reported as
    // unimported configuration.
    expect(
      report.issues.filter(({ code }) => code === "configuration_not_imported"),
    ).toHaveLength(0);
  });
});
