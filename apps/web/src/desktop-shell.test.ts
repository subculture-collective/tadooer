import type { ActiveSession } from "@suite/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  announceCaptureReady,
  captureFieldValue,
  desktopFocusReport,
  desktopShellBridge,
  desktopShellEvents,
  listenToDesktopShell,
  quickCaptureText,
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

  it("finds the Android shell's bridge under its own name", () => {
    const mobile = {
      ...bridge(),
      platform: "android",
      ready: vi.fn(() => true),
    };
    expect(desktopShellBridge({ tadooerMobile: mobile })).toBe(mobile);
    // The desktop bridge wins when both exist, which no shell produces.
    const desktop = bridge();
    expect(
      desktopShellBridge({ tadooerDesktop: desktop, tadooerMobile: mobile }),
    ).toBe(desktop);
    expect(
      desktopShellBridge({ tadooerMobile: { ...bridge(), ready: "yes" } }),
    ).toBeUndefined();
    expect(
      desktopShellBridge({ tadooerShell: bridge(), tadooer: bridge() }),
    ).toBeUndefined();
  });

  it("tells only a shell that asks for it that capture is ready", () => {
    const mobile = { ...bridge(), ready: vi.fn(() => true) };
    expect(announceCaptureReady({ tadooerMobile: mobile })).toBe(true);
    expect(mobile.ready).toHaveBeenCalledTimes(1);
    expect(mobile.ready).toHaveBeenCalledWith();
    // The desktop bridge has no such call; a browser has no bridge.
    expect(announceCaptureReady({ tadooerDesktop: bridge() })).toBe(false);
    expect(announceCaptureReady({})).toBe(false);
    expect(
      announceCaptureReady({
        tadooerMobile: { ...bridge(), ready: () => false },
      }),
    ).toBe(false);
  });

  it("passes shared text from the Android shell to quick capture", () => {
    const target = new EventTarget();
    const handlers = { onQuickCapture: vi.fn(), onSyncNow: vi.fn() };
    const ready = vi.fn(() => true);
    const stop = listenToDesktopShell(
      { tadooerMobile: { ...bridge(), ready } },
      target,
      handlers,
    );
    // Listening does not announce: the app does that once it is signed in.
    expect(ready).not.toHaveBeenCalled();
    target.dispatchEvent(
      new CustomEvent("tadooer:quick-capture", {
        detail: { text: "An article https://example.org/a" },
      }),
    );
    target.dispatchEvent(new Event("tadooer:quick-capture"));
    target.dispatchEvent(
      new CustomEvent("tadooer:quick-capture", { detail: { text: 7 } }),
    );
    expect(handlers.onQuickCapture.mock.calls).toEqual([
      ["An article https://example.org/a"],
      [undefined],
      [undefined],
    ]);
    stop();
  });

  it("accepts one bounded line as shared text and nothing else", () => {
    const event = (detail: unknown) => ({ detail });
    expect(quickCaptureText(event({ text: "  buy milk " }))).toBe("buy milk");
    expect(quickCaptureText(event({ text: "x".repeat(240) }))).toBe(
      "x".repeat(240),
    );
    for (const refused of [
      undefined,
      null,
      "text",
      {},
      event(undefined),
      event(null),
      event("text"),
      event({}),
      event({ text: "" }),
      event({ text: "   " }),
      event({ text: "two\nlines" }),
      event({ text: "tab\there" }),
      event({ text: "bell\u0007" }),
      event({ text: "del\u007f" }),
      event({ text: "x".repeat(241) }),
      event({ text: ["a"] }),
    ])
      expect(quickCaptureText(refused)).toBeUndefined();
  });

  it("keeps what the owner typed when shared text arrives", () => {
    expect(captureFieldValue("", "shared")).toBe("shared");
    expect(captureFieldValue("   ", "shared")).toBe("shared");
    expect(captureFieldValue("call the bank ", "shared")).toBe(
      "call the bank shared",
    );
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
