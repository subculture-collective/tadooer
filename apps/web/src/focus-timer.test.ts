import { describe, expect, it } from "vitest";
import type { FocusTimer } from "@suite/contracts";
import { formatCountdown, localCountdown } from "./focus-timer.ts";
import { createIdleTracker } from "./idle-detector.ts";
import { readFocusSettingsForm } from "./focus-settings.tsx";
import { defaultFocusPreferences } from "@suite/contracts";

const minute = 60_000;

const timer = (
  overrides: Partial<FocusTimer> = {},
  session: Partial<NonNullable<FocusTimer["session"]>> = {},
): FocusTimer => ({
  at: "2026-09-24T15:10:00.000Z",
  session: {
    id: "df8c5e63-3280-4d25-b148-2d0e46e9a19d",
    ownerId: "c6d3a6fa-12c1-4d49-9544-5f85d885e7bc",
    taskId: "afcab502-2199-43fd-b9d3-c8b556c6f25b",
    controllerClientId: "1280d3ef-5f2f-4ac6-90ed-74e60b7157e6",
    state: "running",
    phase: "focus",
    revision: 3,
    startedAt: "2026-09-24T15:00:00.000Z",
    updatedAt: "2026-09-24T15:10:00.000Z",
    leaseExpiresAt: "2026-09-24T15:11:30.000Z",
    hardExpiresAt: "2026-09-25T15:00:00.000Z",
    currentIntervalId: "47f178b0-4f32-4426-a974-13d3592a7c2c",
    ...session,
  },
  plan: {
    mode: "pomodoro",
    workMs: 25 * minute,
    shortBreakMs: 5 * minute,
    longBreakMs: 15 * minute,
    cyclesBeforeLongBreak: 4,
    flowtime: {
      breakEnabled: false,
      breakMode: "ratio",
      breakPercentage: 20,
      breakRules: [],
    },
  },
  countdown: {
    phase: "focus",
    elapsedMs: 10 * minute,
    targetMs: 25 * minute,
    remainingMs: 15 * minute,
    done: false,
    cycle: 1,
    isLongBreak: false,
    reachedAt: null,
  },
  breakReminder: {
    enabled: true,
    workingWithoutBreakMs: 10 * minute,
    thresholdMs: 60 * minute,
    due: false,
    snoozedUntil: null,
  },
  trackingReminder: {
    enabled: false,
    untrackedMs: null,
    thresholdMs: 5 * minute,
    due: false,
    suppressedReason: "tracking",
  },
  idle: {
    enabled: true,
    minIdleMs: 5 * minute,
    onlyWithTask: true,
    suppressed: false,
  },
  ...overrides,
});

describe("browser focus timer (ADR 0029)", () => {
  it("advances the server countdown by local time only while running", () => {
    const received = 1_000_000;
    expect(
      localCountdown(timer(), received, received + 2 * minute),
    ).toMatchObject({
      elapsedMs: 12 * minute,
      remainingMs: 13 * minute,
      done: false,
    });
    expect(
      localCountdown(timer(), received, received + 16 * minute),
    ).toMatchObject({ remainingMs: -minute, done: true });
    expect(
      localCountdown(
        timer({}, { state: "paused" }),
        received,
        received + 16 * minute,
      ),
    ).toMatchObject({ elapsedMs: 10 * minute, done: false });
    expect(
      localCountdown(timer({ countdown: null }), received, received),
    ).toBeNull();
  });

  it("formats countdowns as m:ss, h:mm:ss and overtime", () => {
    expect(formatCountdown(15 * minute)).toBe("15:00");
    expect(formatCountdown(61 * minute + 5_000)).toBe("1:01:05");
    expect(formatCountdown(-90_000)).toBe("+1:30");
  });
});

describe("idle tracker (ADR 0029)", () => {
  it("reports one idle start and one return per span", () => {
    const tracker = createIdleTracker(0);
    expect(tracker.check(4 * minute, 5 * minute)).toBeNull();
    expect(tracker.activity(4 * minute)).toBeNull();
    expect(tracker.check(9 * minute + 1, 5 * minute)).toEqual({
      kind: "idle",
      idleStartedAt: 4 * minute,
    });
    expect(tracker.check(10 * minute, 5 * minute)).toBeNull();
    expect(tracker.activity(12 * minute)).toEqual({
      kind: "returned",
      idleStartedAt: 4 * minute,
      returnedAt: 12 * minute,
    });
    expect(tracker.activity(12 * minute + 1)).toBeNull();
    tracker.reset(20 * minute);
    expect(tracker.idleSince).toBeNull();
    expect(tracker.check(24 * minute, 5 * minute)).toBeNull();
  });
});

describe("focus settings form (ADR 0029)", () => {
  it("reads whole minutes and toggles, keeping saved values for invalid input", () => {
    const data = new FormData();
    data.set("defaultMode", "countdown");
    data.set("workMinutes", "45");
    data.set("shortBreakMinutes", "7");
    data.set("longBreakMinutes", "20");
    data.set("cyclesBeforeLongBreak", "3");
    data.set("flowtimeBreakMode", "rule");
    data.set("breakPercentage", "30");
    data.set("countdownMinutes", "90");
    data.set("breakEndAlarm", "on");
    data.set("idleEnabled", "on");
    data.set("minIdleMinutes", "10");
    data.set("takeABreakEnabled", "on");
    data.set("minWorkingMinutes", "50");
    data.set("snoozeMinutes", "5");
    data.set("takeABreakMessage", "Stretch after ${duration}");
    data.set("trackingReminderMinutes", "15");
    expect(readFocusSettingsForm(data, defaultFocusPreferences)).toEqual({
      ...defaultFocusPreferences,
      defaultMode: "countdown",
      pomodoro: {
        workMinutes: 45,
        shortBreakMinutes: 7,
        longBreakMinutes: 20,
        cyclesBeforeLongBreak: 3,
      },
      flowtime: {
        ...defaultFocusPreferences.flowtime,
        breakEnabled: false,
        breakMode: "rule",
        breakPercentage: 30,
      },
      countdownMinutes: 90,
      autoStartFocusOnTracking: false,
      breakEndAlarm: true,
      idle: {
        enabled: true,
        minIdleMinutes: 10,
        onlyWithTask: false,
        suppressInFocus: false,
      },
      takeABreak: {
        enabled: true,
        minWorkingMinutes: 50,
        snoozeMinutes: 5,
        message: "Stretch after ${duration}",
      },
      trackingReminder: { enabled: false, minMinutes: 15 },
    });
    const invalid = new FormData(); // Missing numbers become NaN, then 0.
    invalid.set("workMinutes", "0");
    expect(readFocusSettingsForm(invalid, defaultFocusPreferences)).toEqual(
      defaultFocusPreferences,
    );
  });
});
