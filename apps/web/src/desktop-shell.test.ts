import type { ActiveSession } from "@suite/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  desktopFocusReport,
  desktopShellBridge,
  desktopShellEvents,
  listenToDesktopShell,
} from "./desktop-shell.ts";

const bridge = () => ({
  version: 1,
  reportStatus: vi.fn(() => true),
  reportFocus: vi.fn(() => true),
  notify: vi.fn(() => true),
});

const session = (
  overrides: Partial<Pick<ActiveSession, "state" | "phase" | "taskId">>,
): ActiveSession =>
  ({
    taskId: "task-1",
    state: "running",
    phase: "focus",
    ...overrides,
  }) as ActiveSession;

describe("desktop shell link", () => {
  it("is absent in a browser", () => {
    expect(desktopShellBridge({})).toBeUndefined();
    expect(desktopShellBridge(undefined)).toBeUndefined();
    expect(desktopShellBridge(globalThis)).toBeUndefined();
  });

  it("accepts only the version 1 bridge with all three calls", () => {
    const present = bridge();
    expect(desktopShellBridge({ tadooerDesktop: present })).toBe(present);
    expect(
      desktopShellBridge({ tadooerDesktop: { ...bridge(), version: 2 } }),
    ).toBeUndefined();
    expect(
      desktopShellBridge({
        tadooerDesktop: { ...bridge(), notify: undefined },
      }),
    ).toBeUndefined();
    expect(desktopShellBridge({ tadooerDesktop: "yes" })).toBeUndefined();
  });

  it("attaches no listener without the bridge", () => {
    const target = new EventTarget();
    const add = vi.spyOn(target, "addEventListener");
    const handlers = { onQuickCapture: vi.fn(), onSyncNow: vi.fn() };
    const stop = listenToDesktopShell({}, target, handlers);
    target.dispatchEvent(new Event(desktopShellEvents.quickCapture));
    target.dispatchEvent(new Event(desktopShellEvents.syncNow));
    stop();
    expect(add).not.toHaveBeenCalled();
    expect(handlers.onQuickCapture).not.toHaveBeenCalled();
    expect(handlers.onSyncNow).not.toHaveBeenCalled();
  });

  it("runs quick capture and sync on the shell's events until stopped", () => {
    const target = new EventTarget();
    const handlers = { onQuickCapture: vi.fn(), onSyncNow: vi.fn() };
    const stop = listenToDesktopShell(
      { tadooerDesktop: bridge() },
      target,
      handlers,
    );
    target.dispatchEvent(new Event("tadooer:quick-capture"));
    target.dispatchEvent(new Event("tadooer:sync-now"));
    target.dispatchEvent(new Event("tadooer:sync-now"));
    target.dispatchEvent(new Event("tadooer:open-file"));
    expect(handlers.onQuickCapture).toHaveBeenCalledTimes(1);
    expect(handlers.onSyncNow).toHaveBeenCalledTimes(2);
    stop();
    target.dispatchEvent(new Event("tadooer:quick-capture"));
    target.dispatchEvent(new Event("tadooer:sync-now"));
    expect(handlers.onQuickCapture).toHaveBeenCalledTimes(1);
    expect(handlers.onSyncNow).toHaveBeenCalledTimes(2);
  });

  it("reports the active focus session with a bounded single-line label", () => {
    const tasks = [
      { id: "task-1", title: "  Write the\nrelease\u0007 notes  " },
      { id: "task-2", title: "x".repeat(300) },
    ];
    expect(desktopFocusReport(undefined, tasks)).toEqual({ state: "idle" });
    expect(desktopFocusReport(null, tasks)).toEqual({ state: "idle" });
    expect(desktopFocusReport(session({ state: "completed" }), tasks)).toEqual({
      state: "idle",
    });
    expect(desktopFocusReport(session({ state: "expired" }), tasks)).toEqual({
      state: "idle",
    });
    expect(desktopFocusReport(session({}), tasks)).toEqual({
      state: "running",
      phase: "focus",
      label: "Write the release notes",
    });
    expect(
      desktopFocusReport(
        session({ state: "paused", phase: "break", taskId: "task-2" }),
        tasks,
      ),
    ).toEqual({ state: "paused", phase: "break", label: "x".repeat(120) });
    expect(desktopFocusReport(session({ taskId: "gone" }), tasks)).toEqual({
      state: "running",
      phase: "focus",
      label: "",
    });
  });
});
