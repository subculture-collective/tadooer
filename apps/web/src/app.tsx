import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { usePlannerLoader } from "./use-planner-loader.ts";
import { googleProjectionFreshness } from "@suite/domain";
import { archiveTask, createTask } from "./api.ts";
import { SessionRecovery } from "./components/SessionRecovery.tsx";
import { PasswordConfirmation } from "./components/PasswordConfirmation.tsx";
import {
  subscribeSessionFailure,
  type SessionFailure,
} from "./session-recovery.ts";
import {
  type HabitListResponse,
  type HabitCommand,
  isHabitSyncOperation,
} from "@suite/contracts";
import { HabitsPage } from "./pages/HabitsPage.tsx";
import { HistoryPage } from "./pages/HistoryPage.tsx";
import { WorklogPage } from "./pages/WorklogPage.tsx";
import { CountersPage } from "./pages/CountersPage.tsx";
import { BoardsPage } from "./pages/BoardsPage.tsx";
import { deadlineFromForm } from "./components/tasks/DeadlineFields.tsx";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";
import type {
  ActiveSession,
  BaikalProbeResponse,
  BaikalStatusResponse,
  ChoicePool,
  ChoicePoolHistoryEvent,
  ChoicePoolItem,
  ChoicePoolSuggestionResponse,
  DayPlanResponse,
  FocusPreferencesResponse,
  GoogleConnectorStatusResponse,
  NotificationPreferences,
  NotificationStatusResponse,
  PlanningPlaceholder,
  PlanningPreferences,
  PlannerResponse,
  Note,
  SavedDayOrder,
  TimeEntry,
  Project,
  SessionResponse,
  Subtask,
  Tag,
  Task,
  TaskPatchRequest,
  TemplatePoolSlot,
} from "@suite/contracts";
import { ApiRequestError, trustedDeviceSessionDays } from "@suite/contracts";
import {
  commandActiveSession,
  connectBaikal,
  probeBaikal,
  createSyncTransport,
  getBaikalStatus,
  getGoogleStatus,
  beginGoogleAuthorization,
  synchronizeGoogle,
  disconnectGoogle,
  withdrawGoogleWriteConsent,
  getPlanningPreferences,
  updatePlanningPreferences,
  getDayPlan,
  getNotificationPreferences,
  getNotificationStatus,
  updateNotificationPreferences,
  sendTestNotification,
  getActiveSession,
  getSetupStatus,
  getTasks,
  getPlanner,
  getProjects,
  getRecoveryTasks,
  getSubtasks,
  getTags,
  getTemplateLibrary,
  getTemplateSets,
  createTemplate,
  createTemplateSet,
  createTemplateFromTask,
  archiveTemplate as archiveTemplateRequest,
  patchTemplate,
  instantiateTemplate,
  instantiateTemplateSet,
  getChoicePools,
  createChoicePool,
  createPlanningPlaceholder,
  suggestPlanningPlaceholder,
  resolvePlanningPlaceholder,
  patchChoicePool,
  createTemplatePoolSlot,
  recordChoicePoolCompletion,
  login,
  logout,
  putTaskTimeBlock,
  patchTask,
  removeTaskTimeBlock,
  resumeSession,
  setupOwner,
  noteBackgroundReads,
} from "./api.ts";
import {
  LocalStore,
  type LocalClientIdentity,
  type TaskConflictReview,
  type ResolveTaskConflictInput,
} from "./local-store.ts";
import { SyncConflictReview } from "./components/SyncConflictReview.tsx";
import type { DayOrderActions } from "./day-order.tsx";
import type { TimeEntryQueue } from "./pages/worklog-controller.ts";
import { liveViewRegistry } from "./live-sync/views.ts";
import type {
  NoteQueue,
  OrganizationQueue,
} from "./components/organization/OrganizationPanel.tsx";
import {
  SyncEngine,
  installOnlineSync,
  type SyncRoundTrigger,
} from "./sync-engine.ts";
import { LiveSyncController } from "./live-sync/controller.ts";
import { useLiveSync } from "./live-sync/use-live-sync.ts";
import {
  captureFieldValue,
  desktopFocusReport,
  desktopShellBridge,
  useDesktopShell,
} from "./desktop-shell.ts";
import {
  useAppLiveViews,
  type LiveAppPatch,
} from "./live-sync/use-app-live-views.ts";
import { Field } from "./field.tsx";
import type { FocusPanelCommand } from "./focus-panel.tsx";
import { useFocusController } from "./focus-controller.ts";
import { FocusReminders } from "./focus-reminders.tsx";
import { IdleReturnDialog } from "./idle-return-dialog.tsx";
import type {
  TemplateBlueprintView,
  TemplateSetView,
  TemplateView,
} from "./template-library.tsx";
import { TodayPage } from "./pages/TodayPage.tsx";
import { TasksPage } from "./pages/TasksPage.tsx";
import { createTaskHierarchyActions } from "./components/tasks/task-hierarchy-actions.ts";
import { ReusePage } from "./pages/ReusePage.tsx";
import { ConnectionsPage } from "./pages/ConnectionsPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { InboxPage } from "./pages/InboxPage.tsx";
import { PlannerPage } from "./pages/PlannerPage.tsx";
import {
  routeFromPath,
  workspaceRoutes,
  type WorkspaceRoute,
} from "./app/routes.ts";
import { AppShell } from "./components/shell/AppShell.tsx";
import { CommandBar } from "./components/command-bar/CommandBar.tsx";
import {
  ApplicationPreferencesProvider,
  useApplicationPreferencesController,
} from "./application-preferences.tsx";
import { ShortcutHelpDialog } from "./components/shortcuts/ShortcutHelpDialog.tsx";
import { shortcutActionFor } from "./shortcuts.ts";

export type AppState =
  | { readonly kind: "loading" }
  | { readonly kind: "setup"; readonly username?: string }
  | {
      readonly kind: "login";
      readonly username?: string;
      readonly message?: string;
    }
  | {
      readonly kind: "authenticated";
      readonly session: SessionResponse;
      readonly baikal: BaikalStatusResponse;
      readonly tasks: readonly Task[];
      readonly recovery: readonly Task[];
      readonly planner: PlannerResponse | null;
      readonly google?: GoogleConnectorStatusResponse;
      readonly planningPreferences?: PlanningPreferences;
      readonly dayPlan?: DayPlanResponse;
      readonly notificationPreferences?: NotificationPreferences;
      readonly notificationStatus?: NotificationStatusResponse;
      readonly client?: LocalClientIdentity;
      readonly activeSession?: ActiveSession | null;
      readonly syncStatus?: "online" | "offline" | "syncing";
      readonly conflictCount?: number;
      readonly conflictReviews?: readonly TaskConflictReview[];
    }
  | {
      readonly kind: "offline";
      readonly tasks: readonly Task[];
      readonly recovery: readonly Task[];
      readonly conflictCount: number;
      readonly conflictReviews?: readonly TaskConflictReview[];
      readonly message: string;
      readonly planningPreferences?: PlanningPreferences;
    }
  | { readonly kind: "error"; readonly message: string };

export interface AppProps {
  readonly initialState?: AppState;
  readonly initialPath?: string;
}

const messageFor = (error: unknown): string =>
  error instanceof ApiRequestError || error instanceof Error
    ? error.message
    : "An unexpected error occurred";

const endpointHost = (endpoint: string): string => {
  try {
    return new URL(endpoint).host;
  } catch {
    return "Configured endpoint";
  }
};

const calendarAccessLabel = (
  calendar: BaikalProbeResponse["calendars"][number],
): string => {
  const kinds = [
    ...(calendar.supportsEvents ? ["events"] : []),
    ...(calendar.supportsTodos ? ["tasks"] : []),
  ];
  const access =
    calendar.canWrite === true
      ? "read and write"
      : calendar.canRead === true
        ? "read only"
        : calendar.canRead === false
          ? "no access"
          : "permissions not reported";
  return `${kinds.length === 0 ? "no supported items" : kinds.join(" and ")}, ${access}`;
};

const formValue = (data: FormData, name: string): string => {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
};

const plannerWindow = (): { readonly from: string; readonly to: string } => {
  const from = new Date();
  from.setUTCHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
};

const localInputToIso = (value: string): string | undefined => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
};

/** Reports the outcome of the explicit Google write consent step (ADR 0040). */
const googleCallbackMessage = (): string | null => {
  if (typeof window === "undefined") return null;
  const outcome = new URLSearchParams(window.location.search).get("google");
  if (outcome === "write-granted")
    return "Google allowed event changes. Writable calendars are marked on Connections.";
  if (outcome === "write-not-granted")
    return "Google did not grant event changes. Your read-only connection is unchanged.";
  return null;
};

export const App = ({ initialState, initialPath }: AppProps) => {
  const [state, setState] = useState<AppState>(
    initialState ?? { kind: "loading" },
  );
  const [busy, setBusy] = useState(false);
  const [freshnessNow, setFreshnessNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setFreshnessNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const [sessionFailure, setSessionFailure] = useState<SessionFailure | null>(
    null,
  );
  useEffect(
    () =>
      subscribeSessionFailure((failure) => {
        if (state.kind === "authenticated") setSessionFailure(failure);
      }),
    [state.kind],
  );
  const recovery =
    state.kind === "authenticated" ? (
      <>
        {/* ADR 0048: the recent-password prompt of a trusted device. */}
        <PasswordConfirmation csrfToken={state.session.csrfToken} />
        {sessionFailure !== null && (
          <SessionRecovery
            failure={sessionFailure}
            username={state.session.owner.username}
            onRecovered={(session) => {
              setState((current) =>
                current.kind === "authenticated"
                  ? { ...current, session }
                  : current,
              );
              setSessionFailure(null);
              setFormError(null);
            }}
          />
        )}
      </>
    ) : null;
  const [formError, setFormError] = useState<string | null>(null);
  const [baikalProbe, setBaikalProbe] = useState<BaikalProbeResponse | null>(
    null,
  );
  const [calendarMessage, setCalendarMessage] = useState<string | null>(
    googleCallbackMessage,
  );
  const [localStore] = useState(() => new LocalStore());
  const [liveSync] = useState(() => new LiveSyncController());
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [tags, setTags] = useState<readonly Tag[]>([]);
  // ADR 0046: notes are read from the offline cache.
  const [notes, setNotes] = useState<readonly Note[]>([]);
  // ADR 0050: saved day orders are read from the offline cache.
  const [dayOrders, setDayOrders] = useState<readonly SavedDayOrder[]>([]);
  // ADR 0050: stored time entries of the rolling window, from the cache.
  const [timeEntries, setTimeEntries] = useState<readonly TimeEntry[]>([]);
  // Issue #114: focus preferences are a read-only offline feed singleton.
  const [cachedFocusPreferences, setCachedFocusPreferences] = useState<
    FocusPreferencesResponse | undefined
  >();
  const timeEntryFeedMark = useRef<string | null | undefined>(undefined);
  const pinnedNotes = notes.filter(({ pinnedToToday }) => pinnedToToday);
  const [subtasks, setSubtasks] = useState<
    Readonly<Record<string, readonly Subtask[]>>
  >({});
  const [templates, setTemplates] = useState<readonly TemplateView[]>([]);
  const [templateBlueprints, setTemplateBlueprints] = useState<
    readonly TemplateBlueprintView[]
  >([]);
  const [templateSets, setTemplateSets] = useState<readonly TemplateSetView[]>(
    [],
  );
  const [templateProvenance, setTemplateProvenance] = useState<
    Readonly<Record<string, string>>
  >({});
  const [choicePools, setChoicePools] = useState<readonly ChoicePool[]>([]);
  const [choicePoolItems, setChoicePoolItems] = useState<
    readonly ChoicePoolItem[]
  >([]);
  const [choicePoolHistory, setChoicePoolHistory] = useState<
    readonly ChoicePoolHistoryEvent[]
  >([]);
  const [planningPlaceholders, setPlanningPlaceholders] = useState<
    readonly PlanningPlaceholder[]
  >([]);
  const [templatePoolSlots, setTemplatePoolSlots] = useState<
    readonly TemplatePoolSlot[]
  >([]);
  const [route, setRoute] = useState<WorkspaceRoute>(() =>
    routeFromPath(
      initialPath ??
        (typeof window === "undefined" ? "/today" : window.location.pathname),
    ),
  );
  const [habitLibrary, setHabitLibrary] = useState<HabitListResponse>({
    habits: [],
    occurrences: [],
  });
  const [habitPending, setHabitPending] = useState(false);
  const [taskQuery, setTaskQuery] = useState("");
  const [taskStatusFilter, setTaskStatusFilter] = useState<
    "all" | Task["status"]
  >("all");
  const [taskProjectFilter, setTaskProjectFilter] = useState("");
  const [taskTagFilter, setTaskTagFilter] = useState("");
  const [networkOnline, setNetworkOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  useEffect(() => {
    const markOnline = (): void => setNetworkOnline(true);
    const markOffline = (): void => setNetworkOnline(false);
    window.addEventListener("online", markOnline);
    window.addEventListener("offline", markOffline);
    return () => {
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
    };
  }, []);

  useEffect(() => {
    const onPopState = (): void => setRoute(routeFromPath(location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = (next: WorkspaceRoute): void => {
    if (typeof history !== "undefined") history.pushState({}, "", `/${next}`);
    setRoute(next);
  };

  // ADR 0030: application preferences, theme and shortcuts for this session.
  const appPreferences = useApplicationPreferencesController(
    state.kind === "authenticated" ? state.session.csrfToken : undefined,
  );
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [startPageApplied, setStartPageApplied] = useState(false);
  const defaultStartPage = appPreferences.snapshot.preferences.defaultStartPage;
  useEffect(() => {
    if (!appPreferences.loaded || startPageApplied) return;
    setStartPageApplied(true);
    const path =
      initialPath ??
      (typeof window === "undefined" ? "/" : window.location.pathname);
    if (path === "/" || path === "") navigate(defaultStartPage);
    // navigate is a stable closure over setRoute; the effect runs once per load.
  }, [appPreferences.loaded, startPageApplied, defaultStartPage, initialPath]);

  const publishPlanner = useCallback((planner: PlannerResponse) => {
    setState((current) =>
      current.kind === "authenticated" ? { ...current, planner } : current,
    );
  }, []);
  const { loadPlanner, plannerLoading, plannerError } = usePlannerLoader(
    state.kind === "authenticated" && sessionFailure === null
      ? `${state.session.owner.id}:${state.session.csrfToken}`
      : null,
    publishPlanner,
    messageFor,
  );

  const visibleTasks =
    state.kind === "authenticated"
      ? state.tasks.filter(
          (task) =>
            (taskQuery.trim() === "" ||
              `${task.title}\n${task.notes}`
                .toLocaleLowerCase()
                .includes(taskQuery.trim().toLocaleLowerCase())) &&
            (taskStatusFilter === "all" || task.status === taskStatusFilter) &&
            (taskProjectFilter === "" ||
              task.projectId === taskProjectFilter) &&
            (taskTagFilter === "" || task.tagIds?.includes(taskTagFilter)),
        )
      : [];

  const cachedTaskState = useCallback(async () => {
    const snapshots = await localStore.loadCachedTasks({
      includeDeleted: true,
    });
    return {
      tasks: snapshots
        .map(({ task }) => task)
        .filter((task) => task.deletedAt == null),
      recovery: snapshots
        .map(({ task }) => task)
        .filter((task) => task.deletedAt != null),
      conflictCount: (await localStore.loadConflicts()).length,
      conflictReviews: await localStore.loadConflictReviews(),
    };
  }, [localStore]);

  // ADR 0033, ADR 0046: projects, tags, checklists and notes are read from
  // the local cache so offline-created records are usable before they have
  // synced.
  const refreshCachedOrganization = useCallback(async () => {
    const [
      cachedProjects,
      cachedTags,
      cachedSubtasks,
      cachedNotes,
      cachedDayOrders,
      cachedTimeEntries,
      focusPreferences,
      feedMark,
    ] = await Promise.all([
      localStore.loadCachedProjects(),
      localStore.loadCachedTags(),
      localStore.loadCachedSubtasks(),
      localStore.loadCachedNotes(),
      localStore.loadCachedDayOrders(),
      localStore.loadCachedTimeEntries(),
      localStore.loadCachedFocusPreferences(),
      localStore.loadTimeEntryFeedMark(),
    ]);
    setProjects(cachedProjects);
    setTags(cachedTags);
    setNotes(cachedNotes);
    setDayOrders(cachedDayOrders);
    setTimeEntries(cachedTimeEntries);
    setCachedFocusPreferences(focusPreferences);
    // ADR 0050: a round delivered a stored time entry, by this tab or by
    // the leader tab. The views that read the server's time report reload;
    // the entry's routes no longer send a `resources` hint.
    if (
      timeEntryFeedMark.current !== undefined &&
      timeEntryFeedMark.current !== feedMark
    )
      liveViewRegistry.refetchViews(["worklog", "timeSpent"]);
    timeEntryFeedMark.current = feedMark;
    setSubtasks(
      cachedSubtasks.reduce<Record<string, Subtask[]>>((grouped, subtask) => {
        (grouped[subtask.taskId] ??= []).push(subtask);
        return grouped;
      }, {}),
    );
  }, [localStore]);

  // What a tab shows after sync rounds were applied, by itself or (ADR 0045)
  // by another tab of this browser profile.
  const readLocalState = useCallback(
    async (client: LocalClientIdentity) => {
      await refreshCachedOrganization();
      setHabitLibrary(await localStore.loadCachedHabits());
      setHabitPending(
        (await localStore.loadOutbox()).some(
          ({ operation, state }) =>
            isHabitSyncOperation(operation) &&
            (state === "queued" || state === "sending"),
        ),
      );
      return {
        ...(await cachedTaskState()),
        client,
        activeSession: await getActiveSession(client),
      };
    },
    [cachedTaskState, localStore, refreshCachedOrganization],
  );

  const runSync = useCallback(
    async (session: SessionResponse, trigger?: SyncRoundTrigger) => {
      const transport = createSyncTransport(session.csrfToken);
      const engine = new SyncEngine(localStore, transport);
      const client = await engine.ensureClient();
      if ((await localStore.loadCachedEntities()).length === 0) {
        await localStore.replaceFromSnapshot(await transport.snapshot(client));
      }
      let round = await engine.sync(undefined, trigger);
      while (round.hasMore) round = await engine.sync(undefined, trigger);
      // The reads that follow a hint-triggered round are not owner activity.
      if (trigger === "push") noteBackgroundReads();
      return readLocalState(client);
    },
    [localStore, readLocalState],
  );

  // Rounds the owner or the app's own lifecycle started. Other tabs reload
  // from IndexedDB afterwards.
  const synchronize = useCallback(
    async (session: SessionResponse) => {
      const local = await runSync(session);
      liveSync.announceRound();
      return local;
    },
    [liveSync, runSync],
  );

  const loadAuthenticated = useCallback(
    async (session: SessionResponse) => {
      const [
        baikal,
        google,
        planningPreferences,
        dayPlan,
        notificationPreferences,
        notificationStatus,
        taskList,
        recoveryList,
        projectList,
        tagList,
        library,
        sets,
        pools,
      ] = await Promise.all([
        getBaikalStatus(),
        getGoogleStatus(),
        getPlanningPreferences(),
        getDayPlan(),
        getNotificationPreferences(),
        getNotificationStatus(),
        getTasks(),
        getRecoveryTasks(),
        getProjects(),
        getTags(),
        getTemplateLibrary(),
        getTemplateSets(),
        getChoicePools(),
      ]);
      setProjects(projectList);
      setTags(tagList);
      setTemplates(library.templates);
      setTemplateBlueprints(library.blueprints);
      setTemplatePoolSlots(library.poolSlots);
      setTemplateProvenance(
        Object.fromEntries(
          library.provenance.map((provenance) => [
            provenance.taskId,
            provenance.templateId,
          ]),
        ),
      );
      setTemplateSets(
        sets.sets.map((set) => ({
          ...set,
          templateIds: sets.members
            .filter((member) => member.setId === set.id)
            .sort((left, right) => left.position - right.position)
            .map((member) => member.templateId),
        })),
      );
      setChoicePools(pools.pools);
      setChoicePoolItems(pools.items);
      setChoicePoolHistory(pools.history);
      setPlanningPlaceholders(pools.placeholders);
      const window = plannerWindow();
      const planner =
        baikal.connected || google.connected
          ? await getPlanner(window.from, window.to)
          : null;
      let local: Awaited<ReturnType<typeof synchronize>> | undefined;
      try {
        local = await synchronize(session);
      } catch {
        // Direct authenticated reads remain a safe first-run fallback. Existing
        // browser profiles retain their IndexedDB cache for offline use.
        // ADR 0046: notes have no direct read; show what the cache holds.
        setNotes(await localStore.loadCachedNotes().catch(() => []));
      }
      const visibleTasks = local?.tasks ?? taskList.tasks;
      try {
        await localStore.savePlanningPreferences(planningPreferences);
      } catch {
        setFormError(
          "Planning preferences are current, but they could not be cached for offline use.",
        );
      }
      const subtaskEntries = await Promise.all(
        visibleTasks.map(
          async (task) => [task.id, await getSubtasks(task.id)] as const,
        ),
      );
      setSubtasks(Object.fromEntries(subtaskEntries));
      setState({
        kind: "authenticated",
        session,
        baikal,
        google,
        planningPreferences,
        dayPlan,
        notificationPreferences,
        notificationStatus,
        tasks: visibleTasks,
        recovery: local?.recovery ?? recoveryList.tasks,
        planner,
        ...(local === undefined
          ? { syncStatus: "offline" as const }
          : {
              client: local.client,
              activeSession: local.activeSession,
              conflictCount: local.conflictCount,
              syncStatus: "online" as const,
            }),
      });
    },
    [localStore, synchronize],
  );

  useEffect(() => {
    if (initialState !== undefined) return;
    const lifecycle = { cancelled: false };
    const cancelled = (): boolean => lifecycle.cancelled;
    void getSetupStatus()
      .then(async ({ setupRequired }) => {
        if (cancelled()) return;
        if (setupRequired) {
          setState({ kind: "setup" });
          return;
        }
        try {
          const session = await resumeSession();
          if (!cancelled()) await loadAuthenticated(session);
        } catch (error: unknown) {
          if (cancelled()) return;
          if (error instanceof ApiRequestError && error.status === 401) {
            setState({ kind: "login" });
          } else {
            setState({ kind: "error", message: messageFor(error) });
          }
        }
      })
      .catch((error: unknown) => {
        if (!cancelled())
          void Promise.all([
            cachedTaskState(),
            localStore.loadPlanningPreferences(),
            localStore.clientIdentity(),
            localStore.loadCachedNotes(),
          ])
            .then(([cached, planningPreferences, identity, cachedNotes]) => {
              // ADR 0046: pinned notes stay readable with no session.
              if (!cancelled() && identity !== undefined) setNotes(cachedNotes);
              if (!cancelled() && identity !== undefined)
                setState({
                  kind: "offline",
                  ...cached,
                  ...(planningPreferences === undefined
                    ? {}
                    : { planningPreferences }),
                  message:
                    "Tadooer cannot reach the server. These are the tasks saved in this browser. Task changes are queued and sync when it is back.",
                });
              else if (!cancelled())
                setState({ kind: "error", message: messageFor(error) });
            })
            .catch(() => {
              if (!cancelled())
                setState({ kind: "error", message: messageFor(error) });
            });
      });
    return () => {
      lifecycle.cancelled = true;
    };
  }, [cachedTaskState, initialState, loadAuthenticated, localStore]);

  useEffect(() => {
    if (state.kind !== "authenticated") return;
    return installOnlineSync(window, async () => {
      setState((current) =>
        current.kind === "authenticated"
          ? { ...current, syncStatus: "syncing" }
          : current,
      );
      try {
        const local = await synchronize(state.session);
        setState((current) =>
          current.kind === "authenticated"
            ? {
                ...current,
                ...local,
                syncStatus: "online",
              }
            : current,
        );
      } catch (error: unknown) {
        setState((current) =>
          current.kind === "authenticated"
            ? { ...current, syncStatus: "offline" }
            : current,
        );
        setFormError(messageFor(error));
      }
    });
  }, [
    state.kind,
    state.kind === "authenticated" ? state.session : null,
    synchronize,
  ]);

  const submitSetup = async (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ): Promise<void> => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const username = formValue(data, "username").toLowerCase();
    setBusy(true);
    setFormError(null);
    try {
      await setupOwner({
        username,
        displayName: formValue(data, "displayName"),
        password: formValue(data, "password"),
      });
      setState({
        kind: "login",
        username,
        message: "Owner account created. Sign in to connect Ba\u00efkal.",
      });
    } catch (error: unknown) {
      setFormError(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const submitLogin = async (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ): Promise<void> => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setFormError(null);
    try {
      const session = await login({
        username: formValue(data, "username"),
        password: formValue(data, "password"),
        // ADR 0048: an unticked box is an ordinary browser session.
        trustDevice: data.get("trustDevice") === "on",
      });
      await loadAuthenticated(session);
    } catch (error: unknown) {
      setFormError(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const submitBaikal = async (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ): Promise<void> => {
    event.preventDefault();
    if (state.kind !== "authenticated") return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setFormError(null);
    try {
      await connectBaikal(
        {
          username: formValue(data, "username"),
          password: formValue(data, "password"),
        },
        state.session.csrfToken,
      );
      await loadAuthenticated(state.session);
      form.reset();
    } catch (error: unknown) {
      setFormError(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const checkBaikal = async (form: HTMLFormElement | null): Promise<void> => {
    if (state.kind !== "authenticated" || form === null) return;
    const data = new FormData(form);
    setBusy(true);
    setFormError(null);
    setBaikalProbe(null);
    try {
      setBaikalProbe(
        await probeBaikal(
          {
            username: formValue(data, "username"),
            password: formValue(data, "password"),
          },
          state.session.csrfToken,
        ),
      );
    } catch (error: unknown) {
      setFormError(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const calendarError = (error: unknown): void => {
    setCalendarMessage(null);
    if (
      error instanceof ApiRequestError &&
      error.status === 401 &&
      error.code === "AUTH_REQUIRED"
    ) {
      setFormError(null);
      setSessionFailure("expired");
    } else {
      setFormError(messageFor(error));
    }
  };

  const calendarSession = async (): Promise<SessionResponse> => {
    const session = await resumeSession();
    setState((current) =>
      current.kind === "authenticated" ? { ...current, session } : current,
    );
    return session;
  };

  const authorizeGoogle = async (
    access: "read" | "write" = "read",
  ): Promise<string> => {
    if (state.kind !== "authenticated") throw new Error("Sign in required");
    setBusy(true);
    setFormError(null);
    try {
      const session = await calendarSession();
      const authorization = await beginGoogleAuthorization(
        session.csrfToken,
        access,
      );
      return authorization.authorizationUrl;
    } catch (error: unknown) {
      calendarError(error);
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const refreshGooglePlanning = async (): Promise<void> => {
    if (state.kind !== "authenticated") return;
    const [google, dayPlan] = await Promise.all([
      getGoogleStatus(),
      getDayPlan(),
    ]);
    const window = plannerWindow();
    const planner =
      state.baikal.connected || google.connected
        ? await getPlanner(window.from, window.to)
        : null;
    setState((current) =>
      current.kind === "authenticated"
        ? { ...current, google, dayPlan, planner }
        : current,
    );
  };

  const syncGoogleCalendar = async (full = false): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    setFormError(null);
    setCalendarMessage(
      full ? "Resyncing Google Calendar…" : "Syncing Google Calendar…",
    );
    try {
      const session = await calendarSession();
      const result = await synchronizeGoogle(session.csrfToken, full);
      setState((current) =>
        current.kind === "authenticated"
          ? { ...current, google: result.status }
          : current,
      );
      if (result.status.state === "reconnect_required") {
        setCalendarMessage(
          "Google authorization has expired or been revoked. Reconnect Google Calendar to resume syncing.",
        );
      } else if (result.status.state !== "connected") {
        setCalendarMessage(
          "Google Calendar did not finish syncing. The events saved last time are kept. Retry without disconnecting.",
        );
      } else {
        setCalendarMessage(
          full ? "Google Calendar resynced." : "Google Calendar synced.",
        );
      }
      await refreshGooglePlanning();
    } catch (error: unknown) {
      calendarError(error);
    } finally {
      setBusy(false);
    }
  };

  const withdrawGoogleWrite = async (): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    setFormError(null);
    try {
      const session = await calendarSession();
      const google = await withdrawGoogleWriteConsent(session.csrfToken);
      setState((current) =>
        current.kind === "authenticated" ? { ...current, google } : current,
      );
      setCalendarMessage(
        "Tadooer will no longer change Google events. Google keeps the permission until you disconnect or remove access in your Google account.",
      );
    } catch (error: unknown) {
      calendarError(error);
    } finally {
      setBusy(false);
    }
  };

  const removeGoogleCalendar = async (): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    setFormError(null);
    setCalendarMessage("Disconnecting Google Calendar…");
    try {
      const session = await calendarSession();
      const result = await disconnectGoogle(session.csrfToken);
      // Publish the completed mutation before refreshing unrelated planning reads.
      setState((current) =>
        current.kind === "authenticated" && current.google !== undefined
          ? {
              ...current,
              google: {
                ...current.google,
                connected: false,
                state: "disconnected",
                providerId: null,
                accountLabel: null,
                grantedScopes: [],
                calendars: [],
                freshness: [],
                write: {
                  consent: "none",
                  consentedAt: null,
                  scopeGranted: false,
                },
                capabilities: [],
              },
            }
          : current,
      );
      setCalendarMessage(
        result.remoteRevoked
          ? "Google Calendar disconnected."
          : "Google Calendar disconnected from Tadooer. Google did not confirm remote access revocation; you can remove access in your Google account.",
      );
      await refreshGooglePlanning();
    } catch (error: unknown) {
      calendarError(error);
    } finally {
      setBusy(false);
    }
  };

  const savePlanningPreferences = async (
    preferences: PlanningPreferences,
  ): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    setFormError(null);
    try {
      const saved = await updatePlanningPreferences(
        preferences,
        state.session.csrfToken,
      );
      const dayPlan = await getDayPlan();
      await localStore.savePlanningPreferences(saved);
      setState((current) =>
        current.kind === "authenticated"
          ? { ...current, planningPreferences: saved, dayPlan }
          : current,
      );
    } catch (error: unknown) {
      setFormError(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const saveNotificationPreferences = async (
    preferences: NotificationPreferences,
  ): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    setFormError(null);
    try {
      const saved = await updateNotificationPreferences(
        preferences,
        state.session.csrfToken,
      );
      const status = await getNotificationStatus();
      setState((current) =>
        current.kind === "authenticated"
          ? {
              ...current,
              notificationPreferences: saved,
              notificationStatus: status,
            }
          : current,
      );
    } catch (error: unknown) {
      setFormError(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const testNotification = async (): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    setFormError(null);
    try {
      await sendTestNotification(state.session.csrfToken);
      const status = await getNotificationStatus();
      setState((current) =>
        current.kind === "authenticated"
          ? { ...current, notificationStatus: status }
          : current,
      );
    } catch (error: unknown) {
      setFormError(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const publishLocalState = async (): Promise<void> => {
    const cached = await cachedTaskState();
    if (state.kind === "authenticated") await refreshCachedOrganization();
    setState((current) =>
      current.kind === "authenticated"
        ? {
            ...current,
            ...cached,
            syncStatus: navigator.onLine
              ? (current.syncStatus ?? "online")
              : "offline",
          }
        : current.kind === "offline"
          ? { ...current, ...cached }
          : current,
    );
  };

  const syncAfterLocalMutation = async (
    savedMessage = "Saved locally",
  ): Promise<void> => {
    await publishLocalState();
    if (state.kind !== "authenticated" || !navigator.onLine) return;
    try {
      const local = await synchronize(state.session);
      setState((current) =>
        current.kind === "authenticated"
          ? { ...current, ...local, syncStatus: "online" }
          : current,
      );
      if (local.conflictCount > 0)
        setFormError(
          "A record changed on another device. Review the sync conflict shown here before retrying.",
        );
    } catch (error: unknown) {
      setState((current) =>
        current.kind === "authenticated"
          ? { ...current, syncStatus: "offline" }
          : current,
      );
      setFormError(`${savedMessage}. ${messageFor(error)}`);
    }
  };

  const resolveConflict = async (
    input: ResolveTaskConflictInput,
  ): Promise<void> => {
    setBusy(true);
    setFormError(null);
    try {
      await localStore.resolveTaskConflict(input);
      await syncAfterLocalMutation("Conflict resolution saved locally");
    } catch (error: unknown) {
      setFormError(messageFor(error));
      await publishLocalState();
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async (): Promise<void> => {
    if (state.kind !== "authenticated" && state.kind !== "offline") return;
    setBusy(true);
    setFormError(null);
    if (state.kind === "offline") {
      try {
        await loadAuthenticated(await resumeSession());
      } catch (error: unknown) {
        setFormError(messageFor(error));
      } finally {
        setBusy(false);
      }
      return;
    }
    setState((current) =>
      current.kind === "authenticated"
        ? { ...current, syncStatus: "syncing" }
        : current,
    );
    try {
      const local = await synchronize(state.session);
      setState((current) =>
        current.kind === "authenticated"
          ? { ...current, ...local, syncStatus: "online" }
          : current,
      );
      if (local.conflictCount > 0)
        setFormError(
          "A record changed on another device. Review the sync conflict shown here before retrying.",
        );
    } catch (error: unknown) {
      setState((current) =>
        current.kind === "authenticated"
          ? { ...current, syncStatus: "offline" }
          : current,
      );
      setFormError(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const submitHabit = async (command: HabitCommand): Promise<void> => {
    if (state.kind !== "authenticated" || !navigator.onLine)
      throw new Error("Connect to change habits");
    const operation = await localStore.queueHabitCommand(command);
    setHabitPending(true);
    await syncAfterLocalMutation();
    const entry = (await localStore.loadOutbox()).find(
      (item) => item.operation.operationId === operation.operationId,
    );
    if (entry?.state !== "acknowledged")
      throw new Error(
        entry?.state === "conflicted"
          ? "This habit changed elsewhere. Review the refreshed habit before trying again."
          : entry?.state === "rejected"
            ? "The habit change was rejected. Check the schedule and try again."
            : "Saved for retry. Use Sync now to finish this change.",
      );
  };

  const submitTask = async (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ): Promise<void> => {
    event.preventDefault();
    if (state.kind !== "authenticated" && state.kind !== "offline") return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setFormError(null);
    let committedTask: Task | undefined;
    try {
      const estimate = Number(formValue(data, "estimateMinutes"));
      if (data.get("structured") === "on") {
        if (state.kind !== "authenticated" || !navigator.onLine)
          throw new Error(
            "Connect to resolve capture markers. Plain tasks can still be captured offline.",
          );
        const input = {
          title: formValue(data, "title"),
          notes: formValue(data, "notes"),
          structured: true,
          createTags: data.get("createTags") === "on",
          estimateMinutes:
            Number.isInteger(estimate) && estimate > 0 ? estimate : null,
        };
        const serialized = JSON.stringify(input);
        const storageKey = `suite.capture.${state.session.owner.id}`;
        const prior = sessionStorage.getItem(storageKey);
        const key =
          prior?.slice(37) === serialized
            ? prior.slice(0, 36)
            : crypto.randomUUID();
        sessionStorage.setItem(storageKey, `${key}:${serialized}`);
        const result = await createTask(input, state.session.csrfToken, key);
        committedTask = result.task;
        sessionStorage.removeItem(storageKey);
        await localStore.cacheCreatedTask(result.task);
      } else {
        await localStore.queueTaskCreate({
          title: formValue(data, "title"),
          notes: formValue(data, "notes"),
          estimateMinutes:
            Number.isInteger(estimate) && estimate > 0 ? estimate : null,
        });
      }
      await syncAfterLocalMutation(
        committedTask === undefined
          ? "Saved locally"
          : "Task saved on the server",
      );
      form.reset();
    } catch (error: unknown) {
      setFormError(
        committedTask === undefined
          ? messageFor(error)
          : `Task saved on the server. Could not refresh the workspace: ${messageFor(error)}`,
      );
    } finally {
      if (committedTask !== undefined) {
        const saved = committedTask;
        setState((current) =>
          current.kind === "authenticated" &&
          !current.tasks.some((task) => task.id === saved.id)
            ? { ...current, tasks: [...current.tasks, saved] }
            : current,
        );
        form.reset();
      }
      setBusy(false);
    }
  };

  const replaceTask = (task: Task): void => {
    if (state.kind !== "authenticated" && state.kind !== "offline") return;
    const tasks = state.tasks.map((candidate) =>
      candidate.id === task.id ? task : candidate,
    );
    if (state.kind === "offline") {
      setState({ ...state, tasks });
      return;
    }
    setState({
      ...state,
      tasks,
      planner:
        state.planner === null
          ? null
          : {
              ...state.planner,
              tasks: state.planner.tasks.map((candidate) =>
                candidate.id === task.id ? task : candidate,
              ),
            },
    });
  };

  const handleTaskError = (error: unknown): void => {
    if (
      error instanceof ApiRequestError &&
      (error.status === 412 || error.code === "CALENDAR_EVENT_CONFLICT")
    ) {
      setFormError(
        error.code === "CALENDAR_EVENT_CONFLICT"
          ? "Calendar changed elsewhere. Refresh before updating this block."
          : "This task changed elsewhere. Reload before editing it.",
      );
      return;
    }
    setFormError(messageFor(error));
  };

  // ADR 0022: archiving is online-only; the sync feed then drops the family.
  const archiveTaskToHistory = async (task: Task): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setFormError(null);
    try {
      await archiveTask(task.id, task.revision, state.session.csrfToken);
      await syncNow();
    } catch (error: unknown) {
      handleTaskError(error);
    }
  };

  const taskHierarchyActions = createTaskHierarchyActions(
    localStore,
    async (queue) => {
      if (state.kind !== "authenticated" && state.kind !== "offline") return;
      setBusy(true);
      setFormError(null);
      try {
        await queue();
        await syncAfterLocalMutation();
      } catch (error: unknown) {
        handleTaskError(error);
      } finally {
        setBusy(false);
      }
    },
  );

  const submitTaskEdit = async (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
    task: Task,
  ): Promise<void> => {
    event.preventDefault();
    if (state.kind !== "authenticated" && state.kind !== "offline") return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setFormError(null);
    try {
      const estimate = Number(formValue(data, "estimateMinutes"));
      await localStore.queueTaskPatch(task.id, {
        title: formValue(data, "title"),
        notes: formValue(data, "notes"),
        deadline: deadlineFromForm(data),
        estimateMinutes:
          Number.isInteger(estimate) && estimate > 0 ? estimate : null,
      });
      await syncAfterLocalMutation();
    } catch (error: unknown) {
      handleTaskError(error);
    } finally {
      setBusy(false);
    }
  };

  const changeTaskStatus = async (
    task: Task,
    action: "complete" | "reopen",
  ): Promise<boolean> => {
    if (state.kind !== "authenticated" && state.kind !== "offline")
      return false;
    setBusy(true);
    setFormError(null);
    try {
      await localStore.queueTaskStatus(task.id, action === "complete");
      await syncAfterLocalMutation();
      return true;
    } catch (error: unknown) {
      handleTaskError(error);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const removeTask = async (task: Task): Promise<void> => {
    if (state.kind !== "authenticated" && state.kind !== "offline") return;
    // ADR 0030 confirmBeforeDelete; deleted tasks stay recoverable.
    if (
      appPreferences.snapshot.preferences.confirmBeforeDelete &&
      typeof window !== "undefined" &&
      !window.confirm(
        `Delete “${task.title}”? It can be recovered from Deleted tasks.`,
      )
    )
      return;
    setBusy(true);
    setFormError(null);
    try {
      await localStore.queueTaskDelete(task.id);
      await syncAfterLocalMutation();
    } catch (error: unknown) {
      handleTaskError(error);
    } finally {
      setBusy(false);
    }
  };

  const recoverTask = async (task: Task): Promise<void> => {
    if (state.kind !== "authenticated" && state.kind !== "offline") return;
    setBusy(true);
    setFormError(null);
    try {
      await localStore.queueTaskRestore(task.id);
      await syncAfterLocalMutation();
    } catch (error: unknown) {
      handleTaskError(error);
    } finally {
      setBusy(false);
    }
  };

  const handleFocusCommand = async (
    command:
      | FocusPanelCommand
      | {
          readonly command: "heartbeat";
          readonly sessionId: string;
          readonly expectedRevision: number;
        },
  ): Promise<void> => {
    if (state.kind !== "authenticated" || state.client === undefined) return;
    setBusy(true);
    setFormError(null);
    try {
      const result = await commandActiveSession(
        state.client,
        state.session.csrfToken,
        { ...command, idempotencyKey: crypto.randomUUID() },
      );
      setState((current) =>
        current.kind === "authenticated"
          ? { ...current, activeSession: result.session }
          : current,
      );
    } catch (error: unknown) {
      handleTaskError(error);
    } finally {
      setBusy(false);
    }
  };

  // ADR 0029: focus presets, idle disposition and break reminders.
  const focus = useFocusController({
    authenticated: state.kind === "authenticated",
    client: state.kind === "authenticated" ? state.client : undefined,
    csrfToken:
      state.kind === "authenticated" ? state.session.csrfToken : undefined,
    activeSession:
      state.kind === "authenticated" ? state.activeSession : undefined,
    online: networkOnline,
    cachedPreferences: cachedFocusPreferences,
    tasks: state.kind === "authenticated" ? state.tasks : [],
    onSessionChanged: (session) =>
      setState((current) =>
        current.kind === "authenticated"
          ? { ...current, activeSession: session }
          : current,
      ),
    onSessionCommand: (command, session) =>
      void handleFocusCommand({
        command,
        sessionId: session.id,
        expectedRevision: session.revision,
      }),
    onNavigateToday: () => navigate("today"),
    onError: (message) => setFormError(message),
  });

  const submitOrganization = async (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
    kind: "project" | "tag",
  ): Promise<void> => {
    event.preventDefault();
    if (state.kind !== "authenticated") return;
    const form = event.currentTarget;
    const title = formValue(new FormData(form), "title").trim();
    if (title === "") return;
    setBusy(true);
    setFormError(null);
    try {
      // ADR 0033: creation queues offline; the server assigns nothing.
      await localStore.queueOrganizationCreate(kind, title);
      form.reset();
      await syncAfterLocalMutation();
    } catch (error: unknown) {
      setFormError(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const organizationQueue: OrganizationQueue = {
    patchProject: async (project, fields) => {
      await localStore.queueOrganizationPatch("project", project.id, fields);
      await syncAfterLocalMutation();
    },
    patchTag: async (tag, fields) => {
      await localStore.queueOrganizationPatch("tag", tag.id, fields);
      await syncAfterLocalMutation();
    },
  };

  // ADR 0046: note writes queue offline with one record revision each.
  // Moving a note swaps two positions with two revisioned patches, as the
  // checklist does; the complete-membership reorder stays an online route.
  const noteQueue: NoteQueue = {
    create: async (input) => {
      await localStore.queueNoteCreate(input);
      await syncAfterLocalMutation();
    },
    patch: async (note, fields) => {
      await localStore.queueNotePatch(note.id, fields);
      await syncAfterLocalMutation();
    },
    remove: async (note) => {
      await localStore.queueNoteDelete(note.id);
      await syncAfterLocalMutation();
    },
    swap: async (note, neighbour) => {
      const [mine, theirs] =
        note.position === neighbour.position
          ? [notes.indexOf(neighbour), notes.indexOf(note)]
          : [neighbour.position, note.position];
      if (mine < 0 || theirs < 0) return;
      await localStore.queueNotePatch(note.id, { position: mine });
      await localStore.queueNotePatch(neighbour.id, { position: theirs });
      await syncAfterLocalMutation();
    },
  };

  // ADR 0050: a day-order reorder queues offline with the saved revision of
  // its date. Planning tasks for a date queues one planned-day patch per
  // task and then the order that places them after the date's members.
  const dayOrderActions: DayOrderActions = {
    reorder: async (date, taskIds) => {
      await localStore.queueDayOrderReorder(date, taskIds);
      await syncAfterLocalMutation();
    },
    plan: async (date, planned, order) => {
      for (const task of planned)
        await localStore.queueTaskPatch(task.id, { plannedDay: date });
      await localStore.queueDayOrderReorder(date, order);
      await syncAfterLocalMutation();
    },
  };

  // ADR 0050: time entry writes without a connection queue one operation
  // each. With a connection the Worklog uses the conditional HTTP routes.
  const timeEntryQueue: TimeEntryQueue = {
    create: async (entry) => {
      await localStore.queueTimeEntryCreate({
        ...entry,
        note: entry.note ?? "",
      });
      await syncAfterLocalMutation();
    },
    patch: async (entry, patch) => {
      await localStore.queueTimeEntryPatch(entry.id, patch);
      await syncAfterLocalMutation();
    },
    remove: async (entry) => {
      await localStore.queueTimeEntryDelete(entry.id);
      await syncAfterLocalMutation();
    },
  };

  const submitTaskOrganization = async (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
    task: Task,
  ): Promise<void> => {
    event.preventDefault();
    if (state.kind !== "authenticated" && state.kind !== "offline") return;
    const data = new FormData(event.currentTarget);
    const projectId = formValue(data, "projectId") || null;
    const tagIds = data
      .getAll("tagIds")
      .filter((value): value is string => typeof value === "string");
    setBusy(true);
    setFormError(null);
    try {
      // ADR 0033: assignment uses the projectId and tagIds field versions.
      await localStore.queueTaskPatch(task.id, { projectId, tagIds });
      await syncAfterLocalMutation();
    } catch (error: unknown) {
      handleTaskError(error);
    } finally {
      setBusy(false);
    }
  };

  const submitSubtask = async (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
    task: Task,
  ): Promise<void> => {
    event.preventDefault();
    if (state.kind !== "authenticated" && state.kind !== "offline") return;
    const form = event.currentTarget;
    const title = formValue(new FormData(form), "title").trim();
    if (title === "") return;
    setBusy(true);
    setFormError(null);
    try {
      await localStore.queueSubtaskCreate(
        task.id,
        title,
        subtasks[task.id]?.length ?? 0,
      );
      form.reset();
      await syncAfterLocalMutation();
    } catch (error: unknown) {
      setFormError(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  // ADR 0033: checklist edits queue offline. Moving an item swaps two
  // positions with two revisioned patches; the complete reorder stays online.
  const changeSubtask = async (
    subtask: Subtask,
    action: "toggle" | "up" | "down" | "delete",
  ): Promise<void> => {
    if (state.kind !== "authenticated" && state.kind !== "offline") return;
    setBusy(true);
    setFormError(null);
    try {
      if (action === "delete") await localStore.queueSubtaskDelete(subtask.id);
      else if (action === "toggle")
        await localStore.queueSubtaskPatch(subtask.id, {
          completed: !subtask.completed,
        });
      else {
        const items = subtasks[subtask.taskId] ?? [];
        const index = items.findIndex(({ id }) => id === subtask.id);
        const other = items[action === "up" ? index - 1 : index + 1];
        if (index < 0 || other === undefined) return;
        const positions = [subtask.position, other.position];
        const [mine, theirs] =
          positions[0] === positions[1]
            ? action === "up"
              ? [index - 1, index]
              : [index + 1, index]
            : [other.position, subtask.position];
        await localStore.queueSubtaskPatch(subtask.id, { position: mine });
        await localStore.queueSubtaskPatch(other.id, { position: theirs });
      }
      await syncAfterLocalMutation();
    } catch (error: unknown) {
      setFormError(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (state.kind !== "authenticated" || state.client === undefined) return;
    const session = state.activeSession;
    if (
      session?.state !== "running" ||
      session.controllerClientId !== state.client.clientId
    )
      return;
    const timeout = window.setTimeout(() => {
      void handleFocusCommand({
        command: "heartbeat",
        sessionId: session.id,
        expectedRevision: session.revision,
      });
    }, 30_000);
    return () => window.clearTimeout(timeout);
  }, [
    state.kind,
    state.kind === "authenticated" ? state.activeSession : null,
    state.kind === "authenticated" ? state.client : null,
  ]);

  const submitTimeBlock = async (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
    task: Task,
  ): Promise<void> => {
    event.preventDefault();
    if (state.kind !== "authenticated") return;
    const data = new FormData(event.currentTarget);
    const startsAt = localInputToIso(formValue(data, "startsAt"));
    const durationMinutes = Number(formValue(data, "durationMinutes"));
    if (startsAt === undefined) {
      setFormError("Choose a valid start time.");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const result = await putTaskTimeBlock(
        task.id,
        task.revision,
        {
          calendarId: formValue(data, "calendarId"),
          startsAt,
          durationMinutes,
        },
        state.session.csrfToken,
        crypto.randomUUID(),
      );
      replaceTask(result.task);
      const window = plannerWindow();
      const [planner, dayPlan] = await Promise.all([
        getPlanner(window.from, window.to),
        getDayPlan(),
        syncAfterLocalMutation(),
      ]);
      setState((current) =>
        current.kind === "authenticated"
          ? { ...current, planner, dayPlan }
          : current,
      );
    } catch (error: unknown) {
      handleTaskError(error);
    } finally {
      setBusy(false);
    }
  };

  // Reminders are online-only (ADR 0020). Without a connection the planned
  // day or time queues through the outbox instead (ADR 0033).
  const submitTaskPlanning = async (
    task: Task,
    patch: TaskPatchRequest,
  ): Promise<void> => {
    if (state.kind !== "authenticated" && state.kind !== "offline") return;
    setBusy(true);
    setFormError(null);
    if (state.kind === "offline" || !navigator.onLine) {
      try {
        await localStore.queueTaskPatch(task.id, {
          plannedDay: patch.plannedDay ?? null,
          plannedStart: patch.plannedStart ?? null,
        });
        await syncAfterLocalMutation();
        if (
          patch.startReminder !== undefined ||
          patch.deadlineReminder !== undefined
        )
          setFormError(
            "Planned day or time saved locally. Reminder settings were not changed; connect to update them.",
          );
      } catch (error: unknown) {
        handleTaskError(error);
      } finally {
        setBusy(false);
      }
      return;
    }
    try {
      const result = await patchTask(
        task.id,
        task.revision,
        patch,
        state.session.csrfToken,
      );
      replaceTask(result.task);
      await syncAfterLocalMutation();
    } catch (error: unknown) {
      handleTaskError(error);
    } finally {
      setBusy(false);
    }
  };

  const removeTimeBlock = async (task: Task): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    setFormError(null);
    try {
      const result = await removeTaskTimeBlock(
        task.id,
        task.revision,
        state.session.csrfToken,
      );
      replaceTask(result.task);
      const window = plannerWindow();
      const [planner, dayPlan] = await Promise.all([
        getPlanner(window.from, window.to),
        getDayPlan(),
        syncAfterLocalMutation(),
      ]);
      setState((current) =>
        current.kind === "authenticated"
          ? { ...current, planner, dayPlan }
          : current,
      );
    } catch (error: unknown) {
      handleTaskError(error);
    } finally {
      setBusy(false);
    }
  };

  // The Sheet needs an action outcome to retain its draft and show its own
  // error. Existing page forms retain their Promise<void> callbacks.
  const submitPlannerTaskEdit = async (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
    task: Task,
  ): Promise<boolean> => {
    event.preventDefault();
    if (state.kind !== "authenticated" && state.kind !== "offline")
      return false;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setFormError(null);
    try {
      const estimate = Number(formValue(data, "estimateMinutes"));
      await localStore.queueTaskPatch(task.id, {
        title: formValue(data, "title"),
        notes: formValue(data, "notes"),
        deadline: deadlineFromForm(data),
        estimateMinutes:
          Number.isInteger(estimate) && estimate > 0 ? estimate : null,
      });
      await syncAfterLocalMutation();
      return true;
    } catch (error: unknown) {
      handleTaskError(error);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submitPlannerTimeBlock = async (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
    task: Task,
    window: { readonly from: string; readonly to: string },
  ): Promise<boolean> => {
    event.preventDefault();
    if (state.kind !== "authenticated") return false;
    const data = new FormData(event.currentTarget);
    const startsAt = localInputToIso(formValue(data, "startsAt"));
    const durationMinutes = Number(formValue(data, "durationMinutes"));
    if (startsAt === undefined) {
      setFormError("Choose a valid start time.");
      return false;
    }
    setBusy(true);
    setFormError(null);
    try {
      const result = await putTaskTimeBlock(
        task.id,
        task.revision,
        {
          calendarId: formValue(data, "calendarId"),
          startsAt,
          durationMinutes,
        },
        state.session.csrfToken,
        crypto.randomUUID(),
      );
      replaceTask(result.task);
      const [planner, dayPlan] = await Promise.all([
        getPlanner(window.from, window.to),
        getDayPlan(),
        syncAfterLocalMutation(),
      ]);
      setState((current) =>
        current.kind === "authenticated"
          ? { ...current, planner, dayPlan }
          : current,
      );
      return true;
    } catch (error: unknown) {
      handleTaskError(error);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const removePlannerTimeBlock = async (
    task: Task,
    window: { readonly from: string; readonly to: string },
  ): Promise<boolean> => {
    if (state.kind !== "authenticated") return false;
    setBusy(true);
    setFormError(null);
    try {
      const result = await removeTaskTimeBlock(
        task.id,
        task.revision,
        state.session.csrfToken,
      );
      replaceTask(result.task);
      const [planner, dayPlan] = await Promise.all([
        getPlanner(window.from, window.to),
        getDayPlan(),
        syncAfterLocalMutation(),
      ]);
      setState((current) =>
        current.kind === "authenticated"
          ? { ...current, planner, dayPlan }
          : current,
      );
      return true;
    } catch (error: unknown) {
      handleTaskError(error);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const signOut = async (): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    try {
      await logout(state.session.csrfToken);
      setState({ kind: "login", username: state.session.owner.username });
    } catch (error: unknown) {
      setFormError(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  // ADR 0030 keyboard shortcuts. Bindings come from the preferences record;
  // the command bar handles its own binding.
  const shortcutOverrides = appPreferences.snapshot.preferences.shortcuts;
  useEffect(() => {
    if (state.kind !== "authenticated" || typeof window === "undefined") return;
    const selectedTask = (): Task | undefined => {
      const row =
        document.activeElement instanceof HTMLElement
          ? document.activeElement.closest<HTMLElement>("[data-task-id]")
          : null;
      const id = row?.dataset.taskId ?? state.activeSession?.taskId;
      return state.tasks.find((task) => task.id === id);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const action = shortcutActionFor(event, shortcutOverrides);
      if (action === undefined || action === "command_bar.open") return;
      event.preventDefault();
      if (action.startsWith("navigate.")) {
        const target = workspaceRoutes.find(
          (candidate) => `navigate.${candidate}` === action,
        );
        if (target !== undefined) navigate(target);
        return;
      }
      switch (action) {
        case "help.shortcuts":
          setShortcutHelpOpen((open) => !open);
          return;
        case "sync.now":
          void syncNow();
          return;
        case "task.add": {
          if (route !== "today" && route !== "inbox") navigate("today");
          window.setTimeout(() => {
            document
              .querySelector<HTMLInputElement>('form input[name="title"]')
              ?.focus();
          }, 0);
          return;
        }
        case "task.toggle_done": {
          const task = selectedTask();
          if (task !== undefined)
            void changeTaskStatus(
              task,
              task.status === "completed" ? "reopen" : "complete",
            );
          return;
        }
        case "focus.toggle": {
          const session = state.activeSession;
          if (
            session != null &&
            session.state !== "completed" &&
            session.state !== "expired"
          ) {
            void handleFocusCommand({
              command: "complete",
              sessionId: session.id,
              expectedRevision: session.revision,
            });
            return;
          }
          const task = selectedTask();
          if (task?.status === "open")
            void handleFocusCommand({ command: "start", taskId: task.id });
          return;
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const refreshTemplateLibrary = async (query = ""): Promise<void> => {
    const [library, sets] = await Promise.all([
      getTemplateLibrary(query),
      getTemplateSets(),
    ]);
    setTemplates(library.templates);
    setTemplateBlueprints(library.blueprints);
    setTemplatePoolSlots(library.poolSlots);
    setTemplateProvenance(
      Object.fromEntries(
        library.provenance.map((provenance) => [
          provenance.taskId,
          provenance.templateId,
        ]),
      ),
    );
    setTemplateSets(
      sets.sets.map((set) => ({
        ...set,
        templateIds: sets.members
          .filter((member) => member.setId === set.id)
          .sort((left, right) => left.position - right.position)
          .map((member) => member.templateId),
      })),
    );
  };

  const submitTemplateCreate = async (draft: {
    title: string;
    notes: string;
    estimateMinutes: number | null;
    suggestedProjectId: string | null;
    tagIds: readonly string[];
    subtasks: readonly { title: string }[];
  }): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    setFormError(null);
    try {
      await createTemplate(draft, state.session.csrfToken);
      await refreshTemplateLibrary();
    } catch (error: unknown) {
      setFormError(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const archiveTemplate = async (template: TemplateView): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    setFormError(null);
    try {
      await archiveTemplateRequest(
        template.id,
        template.revision,
        state.session.csrfToken,
      );
      await refreshTemplateLibrary();
    } catch (error: unknown) {
      handleTaskError(error);
    } finally {
      setBusy(false);
    }
  };

  const editTemplate = async (
    template: TemplateView,
    draft: {
      title: string;
      notes: string;
      estimateMinutes: number | null;
      suggestedProjectId: string | null;
      tagIds: readonly string[];
      subtasks: readonly { title: string }[];
    },
  ): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    setFormError(null);
    try {
      await patchTemplate(
        template.id,
        template.revision,
        draft,
        state.session.csrfToken,
      );
      await refreshTemplateLibrary();
    } catch (error: unknown) {
      handleTaskError(error);
    } finally {
      setBusy(false);
    }
  };

  const submitTemplateSetCreate = async (
    title: string,
    templateIds: readonly string[],
  ): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    setFormError(null);
    try {
      await createTemplateSet(title, templateIds, state.session.csrfToken);
      await refreshTemplateLibrary();
    } catch (error: unknown) {
      setFormError(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const applyInstantiation = async (
    response: Awaited<ReturnType<typeof instantiateTemplate>>,
  ): Promise<void> => {
    const newTasks = response.tasks.map(({ task }) => task);
    setState((current) =>
      current.kind === "authenticated"
        ? { ...current, tasks: [...current.tasks, ...newTasks] }
        : current,
    );
    setSubtasks((current) => ({
      ...current,
      ...Object.fromEntries(
        response.tasks.map(({ task, subtasks: items }) => [task.id, items]),
      ),
    }));
    setTemplateProvenance((current) => ({
      ...current,
      ...Object.fromEntries(
        response.tasks.map(({ provenance }) => [
          provenance.taskId,
          provenance.templateId,
        ]),
      ),
    }));
    await syncAfterLocalMutation();
  };

  const submitTemplateInstantiation = async (
    templateId: string,
    destinationProjectId: string,
  ): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    setFormError(null);
    try {
      await applyInstantiation(
        await instantiateTemplate(
          templateId,
          destinationProjectId,
          state.session.csrfToken,
          crypto.randomUUID(),
        ),
      );
    } catch (error: unknown) {
      handleTaskError(error);
    } finally {
      setBusy(false);
    }
  };

  const submitTemplateSetInstantiation = async (
    setId: string,
    destinationProjectId: string,
  ): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    setFormError(null);
    try {
      await applyInstantiation(
        await instantiateTemplateSet(
          setId,
          destinationProjectId,
          state.session.csrfToken,
          crypto.randomUUID(),
        ),
      );
    } catch (error: unknown) {
      handleTaskError(error);
    } finally {
      setBusy(false);
    }
  };

  const saveTaskAsTemplate = async (task: Task): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    setFormError(null);
    try {
      await createTemplateFromTask(task.id, state.session.csrfToken);
      await refreshTemplateLibrary();
    } catch (error: unknown) {
      setFormError(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const refreshChoicePools = async (): Promise<void> => {
    const library = await getChoicePools();
    setChoicePools(library.pools);
    setChoicePoolItems(library.items);
    setChoicePoolHistory(library.history);
    setPlanningPlaceholders(library.placeholders);
  };

  const submitChoicePool = async (input: {
    title: string;
    policy: "none" | "cooldown" | "cycle" | "one_shot";
    pickCount: number;
    cooldownSeconds: number | null;
    items: readonly { title: string }[];
  }): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    setFormError(null);
    try {
      await createChoicePool(input, state.session.csrfToken);
      await refreshChoicePools();
    } catch (error: unknown) {
      setFormError(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const editChoicePool = async (
    pool: ChoicePool,
    input: {
      title: string;
      policy: ChoicePool["policy"];
      pickCount: number;
      cooldownSeconds: number | null;
      items: readonly { readonly id?: string; readonly title: string }[];
    },
  ): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    setFormError(null);
    try {
      await patchChoicePool(
        pool.id,
        pool.revision,
        {
          ...input,
          items: input.items.map((item) => ({
            title: item.title,
            ...(item.id === undefined ? {} : { id: item.id }),
          })),
        },
        state.session.csrfToken,
      );
      await refreshChoicePools();
    } catch (error: unknown) {
      handleTaskError(error);
    } finally {
      setBusy(false);
    }
  };

  const addTemplatePoolSlot = async (
    templateId: string,
    poolId: string,
    pickCount: number,
    position: number,
  ): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    setFormError(null);
    try {
      await createTemplatePoolSlot(
        templateId,
        { poolId, pickCount, position },
        state.session.csrfToken,
      );
      await refreshTemplateLibrary();
    } catch (error: unknown) {
      setFormError(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const completeChoicePoolItem = async (
    poolId: string,
    itemId: string,
    placeholderId: string,
  ): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    try {
      await recordChoicePoolCompletion(
        poolId,
        itemId,
        placeholderId,
        state.session.csrfToken,
      );
      await refreshChoicePools();
    } catch (error: unknown) {
      setFormError(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const submitPlanningPlaceholder = async (
    taskId: string,
    poolId: string,
  ): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    setFormError(null);
    try {
      await createPlanningPlaceholder(taskId, poolId, state.session.csrfToken);
      await refreshChoicePools();
    } catch (error: unknown) {
      setFormError(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const previewPlanningPlaceholder = async (
    placeholderId: string,
  ): Promise<ChoicePoolSuggestionResponse> => {
    setFormError(null);
    try {
      return await suggestPlanningPlaceholder(placeholderId);
    } catch (error: unknown) {
      setFormError(messageFor(error));
      throw error;
    }
  };

  const submitPlaceholderResolution = async (
    placeholder: PlanningPlaceholder,
    suggestion: ChoicePoolSuggestionResponse,
    selectedItemIds: readonly string[],
    override: boolean,
  ): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    setFormError(null);
    try {
      const resolved = await resolvePlanningPlaceholder(
        placeholder.id,
        {
          selectedItemIds,
          logicalTime: suggestion.logicalTime,
          override,
          expectedRevision: placeholder.revision,
        },
        state.session.csrfToken,
        crypto.randomUUID(),
      );
      setSubtasks((current) => ({
        ...current,
        [placeholder.taskId]: [
          ...(current[placeholder.taskId] ?? []),
          ...resolved.subtasks.filter(
            ({ id }) =>
              !(current[placeholder.taskId] ?? []).some(
                (existing) => existing.id === id,
              ),
          ),
        ],
      }));
      await refreshChoicePools();
      await syncAfterLocalMutation();
    } catch (error: unknown) {
      handleTaskError(error);
    } finally {
      setBusy(false);
    }
  };

  const exportDiagnostics = async (): Promise<void> => {
    const manifest = await localStore.recoverySupportManifest();
    const url = URL.createObjectURL(
      new Blob([`${JSON.stringify(manifest, null, 2)}\n`], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `suite-sync-diagnostics-${manifest.exportedAt.slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // ADR 0045 live sync. The stream, tab leader election and fallback
  // triggers live in ./live-sync; the shell supplies its sync and reload.
  const liveSession =
    state.kind === "authenticated" && sessionFailure === null
      ? state.session
      : null;
  const liveStatus = useLiveSync(liveSync, liveSession?.csrfToken ?? null, {
    identity: () => localStore.clientIdentity(),
    sync: async (trigger) => {
      if (liveSession === null) return;
      const local = await runSync(liveSession, trigger);
      setState((current) =>
        current.kind === "authenticated"
          ? {
              ...current,
              ...local,
              syncStatus:
                current.syncStatus === "syncing" ? "syncing" : "online",
            }
          : current,
      );
    },
    reloadLocal: async () => {
      const client = await localStore.clientIdentity();
      if (client === undefined) return;
      const local = await readLocalState(client);
      setState((current) =>
        current.kind === "authenticated" ? { ...current, ...local } : current,
      );
    },
  });
  // ADR 0047 and ADR 0049: inside the desktop shell the tray shows this state
  // and can ask for quick capture or a sync; the Android shell passes on text
  // shared from another app. In a browser this does nothing.
  useDesktopShell({
    status: {
      sync:
        state.kind === "authenticated"
          ? (state.syncStatus ?? "online")
          : state.kind === "offline"
            ? "offline"
            : "signed-out",
      live: liveStatus,
      conflicts:
        state.kind === "authenticated" || state.kind === "offline"
          ? (state.conflictCount ?? 0)
          : 0,
    },
    focus: desktopFocusReport(
      state.kind === "authenticated" ? state.activeSession : null,
      state.kind === "authenticated" ? state.tasks : [],
    ),
    captureReady: state.kind === "authenticated",
    onQuickCapture: (sharedText) => {
      if (state.kind !== "authenticated") return;
      if (route !== "today" && route !== "inbox") navigate("today");
      // The capture form may not be mounted yet, right after sign-in or a
      // route change. Shared text waits for it for up to a second; a plain
      // request to focus the field is tried once, as before.
      let attempts = sharedText === undefined ? 1 : 20;
      const place = (): void => {
        const title = document.querySelector<HTMLInputElement>(
          'form input[name="title"]',
        );
        attempts -= 1;
        if (title === null) {
          if (attempts > 0) window.setTimeout(place, 50);
          return;
        }
        // ADR 0049: text shared to the Android app is placed in the field
        // for the owner to review. Nothing submits it.
        if (sharedText !== undefined)
          title.value = captureFieldValue(title.value, sharedText);
        title.focus();
      };
      window.setTimeout(place, 0);
    },
    onSyncNow: () => void syncNow(),
  });
  const patchAuthenticated = useCallback((patch: LiveAppPatch) => {
    setState((current) =>
      current.kind === "authenticated" ? { ...current, ...patch } : current,
    );
  }, []);
  useAppLiveViews({
    enabled: liveSession !== null && networkOnline,
    calendarConnected:
      state.kind === "authenticated" &&
      (state.baikal.connected || state.google?.connected === true),
    plannerPageOpen: route === "planner",
    plannerWindow,
    patch: patchAuthenticated,
    cachePlanningPreferences: (preferences) =>
      localStore.savePlanningPreferences(preferences),
    refreshTemplates: () => refreshTemplateLibrary(),
    refreshChoicePools: () => refreshChoicePools(),
  });

  /* ── Render ─────────────────────────────────────────────────── */
  const offlineState = state.kind === "offline" ? state : undefined;
  const shouldRenderOffline = (): boolean => offlineState !== undefined;
  const offlineForRender = (): Extract<
    AppState,
    { readonly kind: "offline" }
  > => {
    if (offlineState === undefined)
      throw new Error("Offline state is unavailable");
    return offlineState;
  };
  if (shouldRenderOffline()) {
    const renderedOfflineState = offlineForRender();
    return (
      <main className="main">
        <SyncConflictReview
          reviews={renderedOfflineState.conflictReviews ?? []}
          busy={busy}
          onResolve={resolveConflict}
        />
        <TodayPage
          dayPlan={undefined}
          planningPreferences={renderedOfflineState.planningPreferences}
          tasks={renderedOfflineState.tasks}
          activeSession={null}
          clientId={null}
          syncStatus="offline"
          planner={null}
          baikalCalendars={[]}
          calendarActionsAvailable={false}
          focusActionsAvailable={false}
          busy={busy}
          onFocusCommand={() => undefined}
          onSubmitTask={submitTask}
          onChangeTaskStatus={changeTaskStatus}
          onSubmitTimeBlock={submitTimeBlock}
          onRemoveTimeBlock={removeTimeBlock}
          onViewTasks={() => navigate("tasks")}
          pinnedNotes={pinnedNotes}
        />
        <section aria-label="Offline sync status">
          <p>Visible sync conflicts: {renderedOfflineState.conflictCount}</p>
          {formError !== null ? (
            <p className="message message-error">{formError}</p>
          ) : null}
          <Button
            variant="ghost"
            type="button"
            disabled={busy}
            onClick={() => void syncNow()}
          >
            Sync now
          </Button>
          <Button
            variant="ghost"
            type="button"
            onClick={() => void exportDiagnostics()}
          >
            Export redacted sync diagnostics
          </Button>
        </section>
      </main>
    );
  }
  const isAuth =
    state.kind === "loading" ||
    state.kind === "error" ||
    state.kind === "setup" ||
    state.kind === "login" ||
    state.kind === "offline" ||
    !state.baikal.connected;

  const auth = isAuth;
  if (auth)
    return (
      <div className="auth-centre">
        <div className="auth-card">
          {recovery}
          {state.kind === "loading" && (
            <div className="auth-loading">
              <div className="status-dot online" />
              <p className="muted">Opening the planner...</p>
            </div>
          )}
          {state.kind === "error" && (
            <div>
              <p className="step">Connection problem</p>
              <h2>Unable to reach Tadooer</h2>
              <p className="muted">{state.message}</p>
              <Button onClick={() => location.reload()}>Retry</Button>
            </div>
          )}
          {state.kind === "setup" && (
            <form onSubmit={(event) => void submitSetup(event)}>
              <p className="step">Step 1 of 2</p>
              <h2>Create the owner account</h2>
              <p className="muted">
                This planner has one owner. Everything in it belongs to this
                account.
              </p>
              <Field
                label="Display name"
                name="displayName"
                autoComplete="name"
              />
              <Field
                label="Username"
                name="username"
                autoComplete="username"
                minLength={3}
              />
              <Field
                label="Password"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={14}
              />
              <p className="hint">
                Use at least 14 characters. A memorable passphrase works well.
              </p>
              {formError !== null && (
                <p className="message message-error">{formError}</p>
              )}
              <Button className="w-full" disabled={busy}>
                {busy ? "Creating..." : "Create owner"}
              </Button>
            </form>
          )}
          {state.kind === "login" && (
            <form onSubmit={(event) => void submitLogin(event)}>
              <p className="step">Private planner</p>
              <h2>Sign in</h2>
              {state.message !== undefined && (
                <p className="message message-success">{state.message}</p>
              )}
              <Field
                label="Username"
                name="username"
                autoComplete="username"
                {...(state.username === undefined
                  ? {}
                  : { defaultValue: state.username })}
              />
              <Field
                label="Password"
                name="password"
                type="password"
                autoComplete="current-password"
              />
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="trustDevice"
                  defaultChecked={desktopShellBridge() !== undefined}
                />
                Keep me signed in on this device for{" "}
                {String(trustedDeviceSessionDays)} days
              </label>
              <p className="hint">
                Only choose this on a device that you alone use. You can sign a
                device out from Settings.
              </p>
              {state.username !== undefined && (
                <p className="message message-error">
                  The session expired. Sign in again.
                </p>
              )}
              {formError !== null && (
                <p className="message message-error">{formError}</p>
              )}
              <Button className="w-full" disabled={busy}>
                {busy ? "Signing in..." : "Sign in"}
              </Button>
            </form>
          )}
          {state.kind === "offline" && (
            <div>
              <p className="step">Offline</p>
              <h2>Limited workspace</h2>
              <p className="muted">{state.message}</p>
              {formError !== null && (
                <p className="message message-error">{formError}</p>
              )}
              <nav className="offline-nav" aria-label="Offline views">
                {workspaceRoutes.map((item) => (
                  <a
                    key={item}
                    href={`/${item}`}
                    aria-current={route === item ? "page" : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      navigate(item);
                    }}
                  >
                    {item === "reuse"
                      ? "Reuse"
                      : item.charAt(0).toUpperCase() + item.slice(1)}
                  </a>
                ))}
              </nav>
              <div>
                <form
                  className="offline-capture"
                  onSubmit={(event) => void submitTask(event)}
                >
                  <Input
                    type="text"
                    name="title"
                    required
                    placeholder="Capture a task..."
                    aria-label="Task title"
                  />
                  <Input
                    type="text"
                    name="notes"
                    placeholder="Notes (optional)"
                    aria-label="Task notes"
                  />
                  <Button type="submit" disabled={busy}>
                    Add
                  </Button>
                </form>
                <ul className="tasks" role="list">
                  {state.tasks.map((task) => (
                    <li
                      key={task.id}
                      className={
                        task.status === "completed"
                          ? "task--completed"
                          : undefined
                      }
                    >
                      <div className="task-heading">
                        <span>{task.title}</span>
                        <span className="mono">{task.revision}</span>
                      </div>
                      {task.notes !== "" && <p>{task.notes}</p>}
                      <div className="task-actions">
                        <Button
                          variant="ghost"
                          type="button"
                          onClick={() =>
                            void changeTaskStatus(
                              task,
                              task.status === "completed"
                                ? "reopen"
                                : "complete",
                            )
                          }
                        >
                          {task.status === "completed" ? "Reopen" : "Complete"}
                        </Button>
                        <Button
                          variant="destructive"
                          type="button"
                          onClick={() => void removeTask(task)}
                        >
                          Delete
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
                <details className="recovery">
                  <summary>Deleted tasks ({state.recovery.length})</summary>
                  {state.recovery.map((task) => (
                    <Button
                      key={task.id}
                      type="button"
                      onClick={() => void recoverTask(task)}
                    >
                      Restore {task.title}
                    </Button>
                  ))}
                </details>
                <p className="hint">
                  Visible sync conflicts: {state.conflictCount}
                </p>
                <Button
                  variant="ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => void syncNow()}
                >
                  Sync now
                </Button>
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => void exportDiagnostics()}
                >
                  Export redacted sync diagnostics
                </Button>
              </div>
            </div>
          )}
          {state.kind === "authenticated" && !state.baikal.connected && (
            <form onSubmit={(event) => void submitBaikal(event)}>
              <p className="step">Step 2 of 2</p>
              <h2>Connect Baikal</h2>
              <p className="muted">
                Enter the Baikal user you created. Tadooer checks it against the
                calendar server, then stores the password encrypted.
              </p>
              <p className="hint mono">
                {endpointHost(state.baikal.endpoint)} \u00b7 server-managed
                CalDAV
              </p>
              <Field
                label="Baikal username"
                name="username"
                autoComplete="username"
              />
              <Field
                label="Baikal password"
                name="password"
                type="password"
                autoComplete="current-password"
              />
              {formError !== null && (
                <p className="message message-error">{formError}</p>
              )}
              {baikalProbe !== null && (
                <div aria-live="polite">
                  <p className="muted">
                    CalDAV answered. {baikalProbe.writableEventCalendars} of{" "}
                    {baikalProbe.calendars.length} calendars accept Tadooer
                    events.
                  </p>
                  <ul>
                    {baikalProbe.calendars.map((calendar) => (
                      <li key={calendar.href}>
                        {calendar.displayName}: {calendarAccessLabel(calendar)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <Button
                variant="outline"
                type="button"
                className="w-full"
                disabled={busy}
                onClick={(event) => void checkBaikal(event.currentTarget.form)}
              >
                Check connection
              </Button>
              <Button className="w-full" disabled={busy}>
                {busy ? "Verifying..." : "Verify and connect"}
              </Button>
            </form>
          )}
        </div>
      </div>
    );

  /* ── Workspace ── */
  const googleView =
    state.google === undefined
      ? undefined
      : {
          ...state.google,
          freshness: state.google.freshness.map((item) => ({
            ...item,
            ...googleProjectionFreshness(
              item.state,
              item.lastSuccessfulSyncAt,
              new Date(Math.max(Date.now(), freshnessNow.getTime())),
            ),
          })),
        };
  const googleStale =
    googleView?.freshness.some((item) => item.state !== "fresh") ?? false;
  const plannerView =
    state.planner !== null && googleStale
      ? {
          ...state.planner,
          freshness: {
            ...state.planner.freshness,
            state: "stale" as const,
            message: "Showing saved calendar events; Google needs a refresh",
          },
        }
      : state.planner;
  const dayPlanView =
    state.dayPlan !== undefined && googleStale
      ? {
          ...state.dayPlan,
          freshness: {
            ...state.dayPlan.freshness,
            state: "stale" as const,
            message: "Showing saved calendar events; Google needs a refresh",
          },
        }
      : state.dayPlan;

  return (
    <ApplicationPreferencesProvider value={appPreferences}>
      <AppShell
        route={route}
        onNavigate={navigate}
        syncStatus={state.syncStatus}
        liveStatus={liveStatus}
        conflictCount={state.conflictCount}
        baikalConnected={state.baikal.connected}
        formError={formError}
        onSignOut={() => void signOut()}
        commandTrigger={
          <CommandBar
            onNavigate={navigate}
            onSyncNow={() => void syncNow()}
            syncAvailable={networkOnline && state.client !== undefined}
            onShowShortcuts={() => setShortcutHelpOpen(true)}
          />
        }
      >
        <ShortcutHelpDialog
          open={shortcutHelpOpen}
          overrides={shortcutOverrides}
          onOpenChange={setShortcutHelpOpen}
        />
        {recovery}
        <SyncConflictReview
          reviews={state.conflictReviews ?? []}
          busy={busy}
          onResolve={resolveConflict}
        />
        <FocusReminders
          {...focus.reminders}
          busy={busy || focus.busy}
          online={networkOnline && state.client !== undefined}
        />
        <IdleReturnDialog {...focus.idleDialog} busy={focus.busy} />
        {route === "today" && (
          <TodayPage
            dayPlan={dayPlanView}
            planningPreferences={state.planningPreferences}
            tasks={state.tasks}
            activeSession={state.activeSession ?? null}
            clientId={state.client?.clientId ?? null}
            syncStatus={state.syncStatus}
            planner={plannerView}
            baikalCalendars={state.baikal.calendars}
            calendarActionsAvailable={networkOnline}
            focusActionsAvailable={networkOnline && state.client !== undefined}
            busy={busy}
            onFocusCommand={(command) => void handleFocusCommand(command)}
            focus={focus.panel}
            onSubmitTask={submitTask}
            onChangeTaskStatus={changeTaskStatus}
            onSubmitTimeBlock={submitTimeBlock}
            onRemoveTimeBlock={removeTimeBlock}
            onViewTasks={() => navigate("tasks")}
            csrfToken={state.session.csrfToken}
            onTasksPlanned={() => void syncNow()}
            dayOrders={dayOrders}
            dayOrderActions={
              state.client === undefined ? undefined : dayOrderActions
            }
            pinnedNotes={pinnedNotes}
          />
        )}
        {route === "inbox" && (
          <InboxPage
            tasks={state.tasks}
            activeSession={state.activeSession ?? null}
            calendars={state.baikal.calendars}
            busy={busy}
            calendarActionsAvailable={networkOnline}
            focusActionsAvailable={networkOnline && state.client !== undefined}
            onSubmitTask={submitTask}
            onStartFocus={(task) =>
              void handleFocusCommand({ command: "start", taskId: task.id })
            }
            onChangeTaskStatus={changeTaskStatus}
            onSubmitTimeBlock={submitTimeBlock}
            onRemoveTimeBlock={removeTimeBlock}
          />
        )}
        {route === "planner" && (
          <PlannerPage
            planner={plannerView}
            timeZone={state.planningPreferences?.timeZone ?? "UTC"}
            busy={busy}
            onLoadPlanner={loadPlanner}
            loading={plannerLoading}
            error={plannerError}
            tasks={state.tasks}
            onChangeTaskStatus={changeTaskStatus}
            onSubmitTaskEdit={submitPlannerTaskEdit}
            calendars={state.baikal.calendars}
            onSubmitTimeBlock={submitPlannerTimeBlock}
            onRemoveTimeBlock={removePlannerTimeBlock}
            dayOrders={dayOrders}
            dayOrderActions={
              state.client === undefined ? undefined : dayOrderActions
            }
          />
        )}
        {route === "tasks" && (
          <TasksPage
            tasks={state.tasks}
            visibleTasks={visibleTasks}
            recovery={state.recovery}
            projects={projects}
            tags={tags}
            subtasks={subtasks}
            provenance={templateProvenance}
            baikalCalendars={state.baikal.calendars}
            taskQuery={taskQuery}
            taskStatusFilter={taskStatusFilter}
            taskProjectFilter={taskProjectFilter}
            taskTagFilter={taskTagFilter}
            busy={busy}
            calendarActionsAvailable={networkOnline}
            onTaskQueryChange={setTaskQuery}
            onTaskStatusFilterChange={setTaskStatusFilter}
            onTaskProjectFilterChange={setTaskProjectFilter}
            onTaskTagFilterChange={setTaskTagFilter}
            onSubmitOrganization={submitOrganization}
            onSubmitTaskEdit={submitTaskEdit}
            onSubmitTimeBlock={submitTimeBlock}
            onRemoveTimeBlock={removeTimeBlock}
            onSubmitTaskOrganization={submitTaskOrganization}
            onSubmitSubtask={submitSubtask}
            onChangeSubtask={changeSubtask}
            onSaveTaskAsTemplate={saveTaskAsTemplate}
            onChangeTaskStatus={changeTaskStatus}
            onRemoveTask={removeTask}
            onRecoverTask={recoverTask}
            onArchiveTask={archiveTaskToHistory}
            organization={{
              csrfToken: state.session.csrfToken,
              online: networkOnline,
              onProjectsChange: setProjects,
              onTagsChange: setTags,
              queue: organizationQueue,
              notes,
              noteQueue,
            }}
            timeZone={state.planningPreferences?.timeZone ?? "UTC"}
            onSubmitTaskPlanning={submitTaskPlanning}
            {...taskHierarchyActions}
          />
        )}
        {route === "history" && (
          <HistoryPage
            csrfToken={state.session.csrfToken}
            online={networkOnline}
            timeZone={state.planningPreferences?.timeZone ?? "UTC"}
            projects={projects}
            onRestored={syncNow}
          />
        )}
        {route === "worklog" && (
          <WorklogPage
            csrfToken={state.session.csrfToken}
            online={networkOnline}
            timeZone={state.planningPreferences?.timeZone ?? "UTC"}
            tasks={state.tasks.filter((task) => task.deletedAt === null)}
            projects={projects}
            cachedEntries={timeEntries}
            queue={state.client === undefined ? undefined : timeEntryQueue}
            onEntriesChanged={() => void syncAfterLocalMutation()}
          />
        )}
        {route === "boards" && (
          <BoardsPage
            csrfToken={state.session.csrfToken}
            online={networkOnline}
            tasks={state.tasks.filter((task) => task.deletedAt === null)}
            projects={projects}
            tags={tags}
          />
        )}
        {route === "counters" && (
          <CountersPage
            csrfToken={state.session.csrfToken}
            online={networkOnline}
            timeZone={state.planningPreferences?.timeZone ?? "UTC"}
          />
        )}
        {route === "habits" && (
          <HabitsPage
            library={habitLibrary}
            timeZone={state.planningPreferences?.timeZone ?? "UTC"}
            online={networkOnline}
            pending={habitPending}
            onCommand={submitHabit}
          />
        )}
        {route === "reuse" && (
          <ReusePage
            templates={templates}
            templateBlueprints={templateBlueprints}
            templateSets={templateSets}
            choicePools={choicePools}
            choicePoolItems={choicePoolItems}
            choicePoolHistory={choicePoolHistory}
            planningPlaceholders={planningPlaceholders}
            templatePoolSlots={templatePoolSlots}
            tasks={state.tasks}
            projects={projects
              .filter((project) => project.archivedAt === null)
              .map(({ id, title }) => ({ id, title }))}
            tags={tags
              .filter((tag) => tag.archivedAt === null)
              .map(({ id, displayName }) => ({ id, displayName }))}
            busy={busy}
            onCreateTemplate={submitTemplateCreate}
            onSearchTemplates={(query) => void refreshTemplateLibrary(query)}
            onArchiveTemplate={archiveTemplate}
            onEditTemplate={editTemplate}
            onCreateTemplateSet={submitTemplateSetCreate}
            onInstantiateTemplate={submitTemplateInstantiation}
            onInstantiateTemplateSet={submitTemplateSetInstantiation}
            onCreateChoicePool={submitChoicePool}
            onCreatePlanningPlaceholder={submitPlanningPlaceholder}
            onEditChoicePool={editChoicePool}
            onAddTemplatePoolSlot={addTemplatePoolSlot}
            onRecordChoicePoolCompletion={completeChoicePoolItem}
            onSuggestPlaceholder={previewPlanningPlaceholder}
            onResolvePlaceholder={submitPlaceholderResolution}
          />
        )}
        {route === "connections" && (
          <ConnectionsPage
            onTaskImport={syncNow}
            calendarMessage={calendarMessage}
            baikal={state.baikal}
            google={googleView}
            planningPreferences={state.planningPreferences}
            dayPlan={dayPlanView}
            csrfToken={state.session.csrfToken}
            busy={busy}
            onAuthorizeGoogle={authorizeGoogle}
            onSyncGoogle={syncGoogleCalendar}
            onDisconnectGoogle={removeGoogleCalendar}
            onAuthorizeGoogleWrite={() => authorizeGoogle("write")}
            onWithdrawGoogleWrite={withdrawGoogleWrite}
            onSavePlanningPreferences={savePlanningPreferences}
          />
        )}
        {route === "settings" && (
          <SettingsPage
            google={googleView}
            planningPreferences={state.planningPreferences}
            dayPlan={dayPlanView}
            notificationPreferences={state.notificationPreferences}
            notificationStatus={state.notificationStatus}
            syncStatus={state.syncStatus}
            liveStatus={liveStatus}
            clientId={state.client?.clientId ?? null}
            plannerFreshness={state.planner?.freshness.state}
            busy={busy}
            onAuthorizeGoogle={authorizeGoogle}
            onSyncGoogle={syncGoogleCalendar}
            onDisconnectGoogle={removeGoogleCalendar}
            onSavePlanningPreferences={savePlanningPreferences}
            onSaveNotificationPreferences={saveNotificationPreferences}
            onTestNotification={testNotification}
            onSyncNow={syncNow}
            onExportDiagnostics={exportDiagnostics}
            focus={focus.settings}
            focusBusy={focus.busy}
            applicationPreferences={appPreferences}
            projects={projects}
            csrfToken={state.session.csrfToken}
            onRestored={syncNow}
            onSignOut={signOut}
          />
        )}
      </AppShell>
    </ApplicationPreferencesProvider>
  );
};
