import { useEffect, useMemo, useRef } from "react";
import type { ActiveSession, Task } from "@suite/contracts";
import type { LiveSyncStatus } from "./live-sync/status.ts";

/**
 * Optional link to a client shell: the desktop app (ADR 0047) or the Android
 * app (ADR 0049).
 *
 * Inside the Electron shell a preload script defines `window.tadooerDesktop`
 * with three calls, and the tray can raise two DOM events. Inside the Android
 * shell an injected script defines `window.tadooerMobile` with the same three
 * calls plus `ready`, and a share from another app raises the quick-capture
 * event with the shared text. In a browser neither object exists, this module
 * attaches nothing and the app behaves exactly as before. A shell only
 * displays what is reported here; it never reads or changes owner data.
 *
 * The exported names say "desktop" because the desktop shell came first; they
 * serve both shells.
 */

export interface DesktopShellStatus {
  readonly sync: "signed-out" | "online" | "syncing" | "offline";
  readonly live: LiveSyncStatus;
  readonly conflicts: number;
}

export type DesktopShellFocus =
  | { readonly state: "idle" }
  | {
      readonly state: "running" | "paused";
      readonly phase: "focus" | "break";
      readonly label: string;
    };

export interface DesktopShellNotification {
  readonly title: string;
  readonly body?: string;
  readonly tag?: string;
  /** An application path such as `/today`, opened when clicked. */
  readonly path?: string;
}

export interface DesktopShellBridge {
  readonly version: 1;
  readonly reportStatus: (report: DesktopShellStatus) => boolean;
  readonly reportFocus: (report: DesktopShellFocus) => boolean;
  /**
   * Shows a native notification while the app runs. Nothing calls this yet:
   * reminder and focus notifications arrive with the notification wave.
   */
  readonly notify: (request: DesktopShellNotification) => boolean;
  /**
   * Android only. Tells the shell that the listeners below are attached, so
   * it can hand over text that was shared before the page was ready.
   */
  readonly ready?: () => boolean;
}

/** Where a shell puts its bridge. The first one present is used. */
export const shellBridgeGlobals = ["tadooerDesktop", "tadooerMobile"] as const;

export const desktopShellEvents = {
  quickCapture: "tadooer:quick-capture",
  syncNow: "tadooer:sync-now",
} as const;

const bridgeCandidate = (
  candidate: unknown,
): DesktopShellBridge | undefined => {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const bridge = candidate as Partial<
    Record<keyof DesktopShellBridge, unknown>
  >;
  return bridge.version === 1 &&
    typeof bridge.reportStatus === "function" &&
    typeof bridge.reportFocus === "function" &&
    typeof bridge.notify === "function" &&
    (bridge.ready === undefined || typeof bridge.ready === "function")
    ? (candidate as DesktopShellBridge)
    : undefined;
};

/** The bridge when this page runs inside the desktop or the Android shell. */
export const desktopShellBridge = (
  scope: unknown = globalThis,
): DesktopShellBridge | undefined => {
  if (typeof scope !== "object" || scope === null) return undefined;
  for (const name of shellBridgeGlobals) {
    const bridge = bridgeCandidate((scope as Record<string, unknown>)[name]);
    if (bridge !== undefined) return bridge;
  }
  return undefined;
};

/** A task title is at most 240 characters; a longer text is not a capture. */
const captureTextLimit = 240;

/**
 * The text a quick-capture event carries, or undefined. The desktop tray
 * sends a plain event. The Android shell sends `detail.text` when another
 * app shared something: one line, already cut to a title's length. Anything
 * else is ignored, so the event still only opens capture.
 */
export const quickCaptureText = (event: unknown): string | undefined => {
  if (typeof event !== "object" || event === null) return undefined;
  const detail = (event as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return undefined;
  const text = (detail as { text?: unknown }).text;
  if (typeof text !== "string") return undefined;
  if (Array.from(text).length > captureTextLimit) return undefined;
  for (const character of text)
    if (character < " " || character === "\u007f") return undefined;
  const trimmed = text.trim();
  return trimmed === "" ? undefined : trimmed;
};

const labelLimit = 120;

/** The focus line for the tray: state, phase and the task title. */
export const desktopFocusReport = (
  session: ActiveSession | null | undefined,
  tasks: readonly Pick<Task, "id" | "title">[],
): DesktopShellFocus => {
  if (
    session === null ||
    session === undefined ||
    (session.state !== "running" && session.state !== "paused")
  )
    return { state: "idle" };
  const title = tasks.find((task) => task.id === session.taskId)?.title ?? "";
  return {
    state: session.state,
    phase: session.phase,
    // One line without control characters, which the shell rejects.
    label: Array.from(title.replace(/\s+/g, " "))
      .filter((character) => character >= " " && character !== "\u007f")
      .join("")
      .trim()
      .slice(0, labelLimit)
      .trim(),
  };
};

export interface DesktopShellHandlers {
  /** `text` is present when the Android shell passes on a share. */
  readonly onQuickCapture: (text?: string) => void;
  readonly onSyncNow: () => void;
}

/**
 * Listens for the shell's two requests. Returns the function that removes
 * the listeners. Without a bridge it attaches nothing.
 */
export const listenToDesktopShell = (
  scope: unknown,
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  handlers: DesktopShellHandlers,
): (() => void) => {
  const bridge = desktopShellBridge(scope);
  if (bridge === undefined) return () => undefined;
  const quickCapture = (event: Event): void => {
    handlers.onQuickCapture(quickCaptureText(event));
  };
  const syncNow = (): void => {
    handlers.onSyncNow();
  };
  target.addEventListener(desktopShellEvents.quickCapture, quickCapture);
  target.addEventListener(desktopShellEvents.syncNow, syncNow);
  return () => {
    target.removeEventListener(desktopShellEvents.quickCapture, quickCapture);
    target.removeEventListener(desktopShellEvents.syncNow, syncNow);
  };
};

/**
 * Tells a shell that has `ready` (the Android shell) that capture can take
 * text now. The shell answers with the quick-capture event when another app
 * shared something before the page could use it. Returns whether a shell was
 * told.
 */
export const announceCaptureReady = (scope: unknown = globalThis): boolean =>
  desktopShellBridge(scope)?.ready?.() === true;

/**
 * The capture field's value after a share. Text the owner already typed is
 * kept and the shared text follows it.
 */
export const captureFieldValue = (current: string, shared: string): string => {
  const typed = current.trim();
  return typed === "" ? shared : `${typed} ${shared}`;
};

export interface DesktopShellInput extends DesktopShellHandlers {
  readonly status: DesktopShellStatus;
  readonly focus: DesktopShellFocus;
  /**
   * True while quick capture can take text: the owner is signed in. The
   * Android shell holds shared text until then.
   */
  readonly captureReady: boolean;
}

/** Reports state to the shell and handles its requests. A no-op in a browser. */
export const useDesktopShell = ({
  status,
  focus,
  captureReady,
  onQuickCapture,
  onSyncNow,
}: DesktopShellInput): void => {
  const bridge = useMemo(() => desktopShellBridge(), []);
  const handlers = useRef<DesktopShellHandlers>({ onQuickCapture, onSyncNow });
  handlers.current = { onQuickCapture, onSyncNow };

  const { sync, live, conflicts } = status;
  useEffect(() => {
    bridge?.reportStatus({ sync, live, conflicts });
  }, [bridge, sync, live, conflicts]);

  const focusState = focus.state;
  const focusPhase = focus.state === "idle" ? undefined : focus.phase;
  const focusLabel = focus.state === "idle" ? undefined : focus.label;
  useEffect(() => {
    bridge?.reportFocus(
      focusState === "idle" ||
        focusPhase === undefined ||
        focusLabel === undefined
        ? { state: "idle" }
        : { state: focusState, phase: focusPhase, label: focusLabel },
    );
  }, [bridge, focusState, focusPhase, focusLabel]);

  useEffect(() => {
    if (bridge === undefined) return;
    return listenToDesktopShell(globalThis, window, {
      onQuickCapture: (text) => {
        handlers.current.onQuickCapture(text);
      },
      onSyncNow: () => {
        handlers.current.onSyncNow();
      },
    });
  }, [bridge]);

  // After the listener effect above, so the answer has somewhere to land.
  useEffect(() => {
    if (captureReady) announceCaptureReady();
  }, [bridge, captureReady]);
};
