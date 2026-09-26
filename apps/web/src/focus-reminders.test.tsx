import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ActiveSession, FocusTimer, Task } from "@suite/contracts";
import { FocusPanel } from "./focus-panel.tsx";
import { FocusReminders } from "./focus-reminders.tsx";

const minute = 60_000;

const task: Task = {
  id: "afcab502-2199-43fd-b9d3-c8b556c6f25b",
  title: "Write the project brief",
  notes: "",
  status: "open",
  revision: 1,
  createdAt: "2026-08-06T12:00:00.000Z",
  updatedAt: "2026-08-06T12:00:00.000Z",
  completedAt: null,
  deletedAt: null,
  plannedStart: null,
  estimateMinutes: null,
};

const session: ActiveSession = {
  id: "df8c5e63-3280-4d25-b148-2d0e46e9a19d",
  ownerId: "c6d3a6fa-12c1-4d49-9544-5f85d885e7bc",
  taskId: task.id,
  controllerClientId: "1280d3ef-5f2f-4ac6-90ed-74e60b7157e6",
  state: "running",
  phase: "focus",
  revision: 3,
  startedAt: "2026-08-06T12:00:00.000Z",
  updatedAt: "2026-08-06T12:05:00.000Z",
  leaseExpiresAt: "2026-08-06T12:10:00.000Z",
  hardExpiresAt: "2026-08-06T20:00:00.000Z",
  currentIntervalId: "47f178b0-4f32-4426-a974-13d3592a7c2c",
};

const timer: FocusTimer = {
  at: "2026-08-06T12:05:00.000Z",
  session,
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
    elapsedMs: 5 * minute,
    targetMs: 25 * minute,
    remainingMs: 20 * minute,
    done: false,
    cycle: 2,
    isLongBreak: false,
    reachedAt: null,
  },
  breakReminder: {
    enabled: true,
    workingWithoutBreakMs: 65 * minute,
    thresholdMs: 60 * minute,
    due: true,
    snoozedUntil: null,
  },
  trackingReminder: {
    enabled: true,
    untrackedMs: 12 * minute,
    thresholdMs: 5 * minute,
    due: true,
    suppressedReason: null,
  },
  idle: {
    enabled: true,
    minIdleMs: 5 * minute,
    onlyWithTask: true,
    suppressed: false,
  },
};

describe("focus panel timer and reminders (ADR 0029)", () => {
  it("shows remaining time, the cycle and the preset control for the controller", () => {
    const markup = renderToStaticMarkup(
      <FocusPanel
        tasks={[task]}
        activeSession={session}
        clientId={session.controllerClientId}
        busy={false}
        online
        onCommand={() => undefined}
        focus={{
          timer,
          receivedAt: Date.now() + 60_000,
          onSelectMode: () => undefined,
        }}
      />,
    );
    expect(markup).toContain("20:00");
    expect(markup).toContain("cycle 2 of 4");
    expect(markup).toContain("Preset");
    expect(markup).toContain("No timer");
  });

  it("shows a follower the preset without the control", () => {
    const markup = renderToStaticMarkup(
      <FocusPanel
        tasks={[task]}
        activeSession={session}
        clientId="e1432ff2-025d-4151-9eb2-9e22f089ffb4"
        busy={false}
        online
        onCommand={() => undefined}
        focus={{
          timer,
          receivedAt: Date.now() + 60_000,
          onSelectMode: () => undefined,
        }}
      />,
    );
    expect(markup).toContain("Preset: Pomodoro");
    expect(markup).not.toContain("No timer");
  });

  it("renders due break and tracking reminders with their actions, and nothing when none is due", () => {
    const props = {
      busy: false,
      online: true,
      trackingDismissed: false,
      onStartBreak: () => undefined,
      onSnoozeBreak: () => undefined,
      onDismissTracking: () => undefined,
      onGoToToday: () => undefined,
    };
    const markup = renderToStaticMarkup(
      <FocusReminders timer={timer} {...props} />,
    );
    expect(markup).toContain("Time for a break");
    expect(markup).toContain("1:05:00");
    expect(markup).toContain("Snooze");
    expect(markup).toContain("Nothing is being tracked");
    expect(
      renderToStaticMarkup(
        <FocusReminders timer={timer} {...props} trackingDismissed />,
      ),
    ).not.toContain("Nothing is being tracked");
    expect(
      renderToStaticMarkup(
        <FocusReminders
          timer={{
            ...timer,
            breakReminder: { ...timer.breakReminder, due: false },
            trackingReminder: { ...timer.trackingReminder, due: false },
          }}
          {...props}
        />,
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(<FocusReminders timer={null} {...props} />),
    ).toBe("");
  });
});
