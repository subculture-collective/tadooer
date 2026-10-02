import { useEffect, useMemo, useRef } from "react";
import type { ActiveSession, Task } from "@suite/contracts";
import type { LiveSyncStatus } from "./live-sync/status.ts";

/**
 * Optional link to the desktop shell (ADR 0047).
 *
 * Inside the Electron shell a preload script defines `window.tadooerDesktop`
 * with three calls, and the tray can raise two DOM events. In a browser the
 * object is absent, this module attaches nothing and the app behaves exactly
 * as before. The shell only displays what is reported here; it never reads or
 * changes owner data.
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
}

export const desktopShellEvents = {
  quickCapture: "tadooer:quick-capture",
  syncNow: "tadooer:sync-now",
} as const;

/** The bridge when this page runs inside the desktop shell. */
export const desktopShellBridge = (
  scope: unknown = globalThis,
): DesktopShellBridge | undefined => {
  if (typeof scope !== "object" || scope === null) return undefined;
  const candidate = (scope as { tadooerDesktop?: unknown }).tadooerDesktop;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const bridge = candidate as Partial<
    Record<keyof DesktopShellBridge, unknown>
  >;
  return bridge.version === 1 &&
    typeof bridge.reportStatus === "function" &&
    typeof bridge.reportFocus === "function" &&
    typeof bridge.notify === "function"
    ? (candidate as DesktopShellBridge)
    : undefined;
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
  readonly onQuickCapture: () => void;
  readonly onSyncNow: () => void;
}

/**
 * Listens for the tray's two requests. Returns the function that removes the
 * listeners. Without a bridge it attaches nothing.
 */
export const listenToDesktopShell = (
  scope: unknown,
  target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  handlers: DesktopShellHandlers,
): (() => void) => {
  if (desktopShellBridge(scope) === undefined) return () => undefined;
  const quickCapture = (): void => {
    handlers.onQuickCapture();
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

export interface DesktopShellInput extends DesktopShellHandlers {
  readonly status: DesktopShellStatus;
  readonly focus: DesktopShellFocus;
}

/** Reports state to the shell and handles its requests. A no-op in a browser. */
export const useDesktopShell = ({
  status,
  focus,
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
      onQuickCapture: () => {
        handlers.current.onQuickCapture();
      },
      onSyncNow: () => {
        handlers.current.onSyncNow();
      },
    });
  }, [bridge]);
};
