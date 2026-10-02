import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiRequestError,
  type ActiveSession,
  type FocusIdleDisposition,
  type FocusMode,
  type FocusPreferences,
  type FocusPreferencesResponse,
  type FocusTimer,
  type Task,
} from "@suite/contracts";
import {
  applyIdleDisposition,
  getFocusPreferences,
  getFocusTimer,
  setFocusPlan,
  snoozeBreakReminder,
  updateFocusPreferences,
} from "./api.ts";
import { playBreakEndAlarm } from "./focus-alarm.ts";
import type { FocusPanelTimerProps } from "./focus-panel.tsx";
import type { FocusRemindersProps } from "./focus-reminders.tsx";
import type { FocusSettingsProps } from "./focus-settings.tsx";
import { localCountdown } from "./focus-timer.ts";
import { useIdleDetection } from "./idle-detector.ts";
import type { IdleReturnDialogProps } from "./idle-return-dialog.tsx";
import type { LocalClientIdentity } from "./local-store.ts";
import { useLiveRefetch, useLiveRevision } from "./live-sync/views.ts";

/**
 * Browser orchestration for focus presets, idle handling and break reminders
 * (ADR 0029). The server owns every instant; this hook polls the timer,
 * mirrors it into the panel and banners, applies preset automation for the
 * controlling device and asks the owner what an idle span was.
 */

export interface FocusApi {
  readonly getFocusPreferences: typeof getFocusPreferences;
  readonly updateFocusPreferences: typeof updateFocusPreferences;
  readonly getFocusTimer: typeof getFocusTimer;
  readonly setFocusPlan: typeof setFocusPlan;
  readonly applyIdleDisposition: typeof applyIdleDisposition;
  readonly snoozeBreakReminder: typeof snoozeBreakReminder;
}

export const defaultFocusApi: FocusApi = {
  getFocusPreferences,
  updateFocusPreferences,
  getFocusTimer,
  setFocusPlan,
  applyIdleDisposition,
  snoozeBreakReminder,
};

export interface FocusControllerInput {
  readonly authenticated: boolean;
  readonly client: LocalClientIdentity | undefined;
  readonly csrfToken: string | undefined;
  readonly activeSession: ActiveSession | null | undefined;
  readonly online: boolean;
  readonly tasks: readonly Task[];
  readonly onSessionChanged: (session: ActiveSession) => void;
  readonly onSessionCommand: (
    command: "start_break" | "end_break",
    session: ActiveSession,
  ) => void;
  readonly onNavigateToday: () => void;
  readonly onError: (message: string) => void;
  readonly api?: FocusApi;
}

export interface FocusController {
  readonly preferences: FocusPreferencesResponse | undefined;
  readonly timer: FocusTimer | null;
  readonly panel: FocusPanelTimerProps | undefined;
  readonly settings: Omit<FocusSettingsProps, "busy" | "online"> | undefined;
  readonly reminders: Omit<FocusRemindersProps, "busy" | "online">;
  readonly idleDialog: Omit<IdleReturnDialogProps, "busy">;
  readonly busy: boolean;
  readonly refresh: () => Promise<void>;
}

const messageFor = (error: unknown): string =>
  error instanceof Error ? error.message : "The request failed";

const terminal = (session: ActiveSession | null | undefined) =>
  session === null ||
  session === undefined ||
  session.state === "completed" ||
  session.state === "expired";

export const useFocusController = ({
  authenticated,
  client,
  csrfToken,
  activeSession,
  online,
  tasks,
  onSessionChanged,
  onSessionCommand,
  onNavigateToday,
  onError,
  api = defaultFocusApi,
}: FocusControllerInput): FocusController => {
  const [preferences, setPreferences] = useState<
    FocusPreferencesResponse | undefined
  >();
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [timer, setTimer] = useState<FocusTimer | null>(null);
  const [receivedAt, setReceivedAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [idle, setIdle] = useState<{
    readonly idleStartedAt: string;
    readonly returnedAt: string;
    readonly sessionId: string;
    readonly error: string | null;
  } | null>(null);
  const [trackingDismissed, setTrackingDismissed] = useState(false);
  const handled = useRef<string | null>(null);
  const alarmed = useRef<string | null>(null);
  const planned = useRef<string | null>(null);
  const ready = authenticated && client !== undefined && online;

  const refresh = useCallback(async (): Promise<void> => {
    if (client === undefined || !ready) return;
    try {
      const next = await api.getFocusTimer(client);
      setTimer(next);
      setReceivedAt(Date.now());
    } catch (error: unknown) {
      if (error instanceof ApiRequestError && error.status >= 500) return;
      setTimer(null);
    }
  }, [api, client, ready]);

  const livePreferences = useLiveRevision("focusPreferences", authenticated);
  useEffect(() => {
    if (!authenticated) {
      setPreferences(undefined);
      setTimer(null);
      return;
    }
    let cancelled = false;
    void api
      .getFocusPreferences()
      .then((record) => {
        if (!cancelled) setPreferences(record);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api, authenticated, livePreferences]);

  const sessionKey = activeSession?.id ?? "none";
  const sessionRevision = activeSession?.revision ?? 0;
  useEffect(() => {
    void refresh();
  }, [refresh, sessionKey, sessionRevision]);
  useLiveRefetch("focusTimer", refresh, ready);

  const running = activeSession?.state === "running";
  useEffect(() => {
    if (!ready) return;
    const interval = window.setInterval(
      () => void refresh(),
      running ? 30_000 : 60_000,
    );
    const onVisibility = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ready, refresh, running]);

  const controller =
    client !== undefined &&
    activeSession?.controllerClientId === client.clientId;

  const selectMode = useCallback(
    async (mode: FocusMode | null): Promise<void> => {
      if (
        client === undefined ||
        csrfToken === undefined ||
        activeSession === null ||
        activeSession === undefined
      )
        return;
      setBusy(true);
      try {
        const next = await api.setFocusPlan(client, csrfToken, {
          sessionId: activeSession.id,
          expectedRevision: activeSession.revision,
          mode,
        });
        setTimer(next);
        setReceivedAt(Date.now());
      } catch (error: unknown) {
        onError(messageFor(error));
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [activeSession, api, client, csrfToken, onError, refresh],
  );

  // Apply the default preset once per new session when the owner asked for it.
  useEffect(() => {
    if (
      !ready ||
      !controller ||
      timer === null ||
      timer.session?.id !== sessionKey ||
      preferences === undefined ||
      !preferences.preferences.autoStartFocusOnTracking ||
      terminal(activeSession) ||
      timer.plan !== null ||
      planned.current === sessionKey
    )
      return;
    planned.current = sessionKey;
    void selectMode(preferences.preferences.defaultMode);
  }, [
    activeSession,
    controller,
    preferences,
    ready,
    selectMode,
    sessionKey,
    timer,
  ]);

  // Pomodoro: a finished focus stretch starts its break; a finished break
  // only alerts, the owner ends it. Countdown: alert only.
  useEffect(() => {
    if (timer === null || activeSession == null) return;
    if (!running || timer.session?.id !== activeSession.id) return;
    const check = () => {
      const countdown = localCountdown(timer, receivedAt, Date.now());
      if (!countdown?.done) return;
      const key = `${activeSession.id}:${String(activeSession.revision)}:${countdown.phase}`;
      if (
        countdown.phase === "break" &&
        preferences?.preferences.breakEndAlarm === true &&
        alarmed.current !== key
      ) {
        alarmed.current = key;
        playBreakEndAlarm();
      }
      if (
        countdown.phase === "focus" &&
        timer.plan?.mode === "pomodoro" &&
        controller &&
        ready &&
        handled.current !== key
      ) {
        handled.current = key;
        onSessionCommand("start_break", activeSession);
      }
    };
    check();
    const interval = window.setInterval(check, 1_000);
    return () => window.clearInterval(interval);
  }, [
    activeSession,
    controller,
    onSessionCommand,
    preferences,
    ready,
    receivedAt,
    running,
    timer,
  ]);

  useEffect(() => {
    if (timer?.trackingReminder.due !== true) setTrackingDismissed(false);
  }, [timer]);

  const idleEnabled =
    ready &&
    preferences?.preferences.idle.enabled === true &&
    timer !== null &&
    !timer.idle.suppressed &&
    (!preferences.preferences.idle.onlyWithTask || running) &&
    idle === null;
  const sessionRef = useRef(activeSession);
  sessionRef.current = activeSession;
  useIdleDetection({
    enabled: idleEnabled,
    minIdleMs: preferences?.preferences.idle.minIdleMinutes
      ? preferences.preferences.idle.minIdleMinutes * 60_000
      : 5 * 60_000,
    onReturn: (idleStartedAt, returnedAt) => {
      const session = sessionRef.current;
      if (client === undefined || session?.state !== "running") return;
      if (
        session.controllerClientId !== client.clientId ||
        Date.parse(idleStartedAt) < Date.parse(session.startedAt)
      )
        return;
      setIdle({
        idleStartedAt,
        returnedAt,
        sessionId: session.id,
        error: null,
      });
    },
  });

  const chooseIdle = useCallback(
    async (disposition: FocusIdleDisposition): Promise<void> => {
      const session = sessionRef.current;
      if (
        idle === null ||
        client === undefined ||
        csrfToken === undefined ||
        session?.id !== idle.sessionId
      ) {
        setIdle(null);
        return;
      }
      setBusy(true);
      try {
        const result = await api.applyIdleDisposition(client, csrfToken, {
          sessionId: session.id,
          expectedRevision: session.revision,
          idleStartedAt: idle.idleStartedAt,
          disposition,
          idempotencyKey: crypto.randomUUID(),
        });
        onSessionChanged(result.session);
        setIdle(null);
        await refresh();
      } catch (error: unknown) {
        if (
          error instanceof ApiRequestError &&
          (error.status === 404 || error.status === 409 || error.status === 412)
        ) {
          // The session moved on; there is nothing left to assign.
          setIdle(null);
          onError(
            "The focus session changed before the idle time was assigned.",
          );
          await refresh();
        } else setIdle({ ...idle, error: messageFor(error) });
      } finally {
        setBusy(false);
      }
    },
    [api, client, csrfToken, idle, onError, onSessionChanged, refresh],
  );

  const savePreferences = useCallback(
    async (next: FocusPreferences): Promise<void> => {
      if (preferences === undefined || csrfToken === undefined) return;
      setBusy(true);
      setSettingsMessage(null);
      try {
        const saved = await api.updateFocusPreferences(
          next,
          preferences.revision,
          csrfToken,
        );
        setPreferences(saved);
        setSettingsMessage("Focus preferences saved.");
        await refresh();
      } catch (error: unknown) {
        if (error instanceof ApiRequestError && error.status === 412) {
          const current = await api
            .getFocusPreferences()
            .catch(() => undefined);
          if (current !== undefined) setPreferences(current);
          setSettingsMessage(
            "Focus preferences changed elsewhere; the current values are shown. Apply your edits again.",
          );
        } else setSettingsMessage(messageFor(error));
      } finally {
        setBusy(false);
      }
    },
    [api, csrfToken, preferences, refresh],
  );

  const snooze = useCallback(async (): Promise<void> => {
    if (csrfToken === undefined) return;
    setBusy(true);
    try {
      await api.snoozeBreakReminder(csrfToken);
      await refresh();
    } catch (error: unknown) {
      onError(messageFor(error));
    } finally {
      setBusy(false);
    }
  }, [api, csrfToken, onError, refresh]);

  const idleTask =
    idle === null
      ? null
      : (tasks.find((task) => task.id === activeSession?.taskId)?.title ??
        null);

  return {
    preferences,
    timer,
    busy,
    refresh,
    panel:
      client === undefined
        ? undefined
        : {
            timer,
            receivedAt,
            onSelectMode: (mode) => void selectMode(mode),
          },
    settings:
      preferences === undefined
        ? undefined
        : {
            record: preferences,
            message: settingsMessage,
            onSave: savePreferences,
          },
    reminders: {
      timer,
      trackingDismissed,
      onStartBreak: () => {
        if (activeSession !== null && activeSession !== undefined)
          onSessionCommand("start_break", activeSession);
      },
      onSnoozeBreak: () => void snooze(),
      onDismissTracking: () => setTrackingDismissed(true),
      onGoToToday: onNavigateToday,
    },
    idleDialog: {
      open: idle !== null,
      idleStartedAt: idle?.idleStartedAt ?? null,
      returnedAt: idle?.returnedAt ?? null,
      taskTitle: idleTask,
      phase: idle === null ? null : (activeSession?.phase ?? null),
      error: idle?.error ?? null,
      onChoose: (disposition) => void chooseIdle(disposition),
    },
  };
};
