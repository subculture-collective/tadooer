import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { usePlannerLoader } from "./use-planner-loader.ts";
import { googleProjectionFreshness } from "@suite/domain";
import { archiveTask, createTask } from "./api.ts";
import { SessionRecovery } from "./components/SessionRecovery.tsx";
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
import { deadlineFromForm } from "./components/tasks/DeadlineFields.tsx";
import { useCallback, useEffect, useState, type SyntheticEvent } from "react";
import type {
  ActiveSession,
  BaikalStatusResponse,
  ChoicePool,
  ChoicePoolHistoryEvent,
  ChoicePoolItem,
  ChoicePoolSuggestionResponse,
  DayPlanResponse,
  GoogleConnectorStatusResponse,
  NotificationPreferences,
  NotificationStatusResponse,
  PlanningPlaceholder,
  PlanningPreferences,
  PlannerResponse,
  Project,
  SessionResponse,
  Subtask,
  Tag,
  Task,
  TaskPatchRequest,
  TemplatePoolSlot,
} from "@suite/contracts";
import { ApiRequestError } from "@suite/contracts";
import {
  commandActiveSession,
  connectBaikal,
  createProject,
  createSubtask,
  deleteSubtask,
  createSyncTransport,
  createTag,
  assignTaskProject,
  assignTaskTags,
  getBaikalStatus,
  getGoogleStatus,
  beginGoogleAuthorization,
  synchronizeGoogle,
  disconnectGoogle,
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
  patchSubtask,
  reorderSubtasks,
  login,
  logout,
  putTaskTimeBlock,
  patchTask,
  removeTaskTimeBlock,
  resumeSession,
  setupOwner,
} from "./api.ts";
import {
  LocalStore,
  type LocalClientIdentity,
  type TaskConflictReview,
  type ResolveTaskConflictInput,
} from "./local-store.ts";
import { SyncConflictReview } from "./components/SyncConflictReview.tsx";
import { SyncEngine, installOnlineSync } from "./sync-engine.ts";
import { Field } from "./field.tsx";
import type { FocusPanelCommand } from "./focus-panel.tsx";
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
import { moveChecklistItem } from "./checklist-order.ts";
import {
  routeFromPath,
  workspaceRoutes,
  type WorkspaceRoute,
} from "./app/routes.ts";
import { AppShell } from "./components/shell/AppShell.tsx";
import { CommandBar } from "./components/command-bar/CommandBar.tsx";

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
    state.kind === "authenticated" && sessionFailure !== null ? (
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
    ) : null;
  const [formError, setFormError] = useState<string | null>(null);
  const [calendarMessage, setCalendarMessage] = useState<string | null>(null);
  const [localStore] = useState(() => new LocalStore());
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [tags, setTags] = useState<readonly Tag[]>([]);
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

  const synchronize = useCallback(
    async (session: SessionResponse) => {
      const transport = createSyncTransport(session.csrfToken);
      const engine = new SyncEngine(localStore, transport);
      const client = await engine.ensureClient();
      if ((await localStore.loadCachedEntities()).length === 0) {
        await localStore.replaceFromSnapshot(await transport.snapshot(client));
      }
      let round = await engine.sync();
      while (round.hasMore) round = await engine.sync();
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
    [cachedTaskState, localStore],
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
          ])
            .then(([cached, planningPreferences, identity]) => {
              if (!cancelled() && identity !== undefined)
                setState({
                  kind: "offline",
                  ...cached,
                  ...(planningPreferences === undefined
                    ? {}
                    : { planningPreferences }),
                  message:
                    "Working from this browser\u2019s durable task cache.",
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

  const authorizeGoogle = async (): Promise<string> => {
    if (state.kind !== "authenticated") throw new Error("Sign in required");
    setBusy(true);
    setFormError(null);
    try {
      const session = await calendarSession();
      const authorization = await beginGoogleAuthorization(session.csrfToken);
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
          "Google Calendar could not finish syncing. The last saved projection has been kept. You can retry without disconnecting.",
        );
      } else {
        setCalendarMessage(
          full
            ? "Google Calendar resynced successfully."
            : "Google Calendar synced successfully.",
        );
      }
      await refreshGooglePlanning();
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
          "A task field changed on another client. Review the visible sync conflict before retrying.",
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
          "A task field changed on another client. Review the visible sync conflict before retrying.",
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

  const submitOrganization = async (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
    kind: "project" | "tag",
  ): Promise<void> => {
    event.preventDefault();
    if (state.kind !== "authenticated") return;
    const form = event.currentTarget;
    const title = formValue(new FormData(form), "title");
    setBusy(true);
    try {
      if (kind === "project")
        setProjects([
          ...projects,
          await createProject(title, state.session.csrfToken),
        ]);
      else setTags([...tags, await createTag(title, state.session.csrfToken)]);
      form.reset();
    } catch (error: unknown) {
      setFormError(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const submitTaskOrganization = async (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
    task: Task,
  ): Promise<void> => {
    event.preventDefault();
    if (state.kind !== "authenticated") return;
    const data = new FormData(event.currentTarget);
    const projectId = formValue(data, "projectId") || null;
    const tagIds = data
      .getAll("tagIds")
      .filter((value): value is string => typeof value === "string");
    setBusy(true);
    try {
      const assignedProject = await assignTaskProject(
        task.id,
        task.revision,
        projectId,
        state.session.csrfToken,
      );
      const assignedTags = await assignTaskTags(
        task.id,
        assignedProject.task.revision,
        tagIds,
        state.session.csrfToken,
      );
      replaceTask(assignedTags.task);
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
    if (state.kind !== "authenticated") return;
    const form = event.currentTarget;
    const title = formValue(new FormData(form), "title");
    setBusy(true);
    try {
      const subtask = await createSubtask(
        task.id,
        { title, position: subtasks[task.id]?.length ?? 0 },
        state.session.csrfToken,
      );
      setSubtasks((current) => ({
        ...current,
        [task.id]: [...(current[task.id] ?? []), subtask],
      }));
      form.reset();
    } catch (error: unknown) {
      setFormError(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const changeSubtask = async (
    subtask: Subtask,
    action: "toggle" | "up" | "down" | "delete",
  ): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    try {
      if (action === "delete") {
        await deleteSubtask(
          subtask.id,
          subtask.revision,
          state.session.csrfToken,
        );
        setSubtasks((current) => ({
          ...current,
          [subtask.taskId]: (current[subtask.taskId] ?? []).filter(
            ({ id }) => id !== subtask.id,
          ),
        }));
      } else {
        if (action === "toggle") {
          const updated = await patchSubtask(
            subtask.id,
            subtask.revision,
            { completed: !subtask.completed },
            state.session.csrfToken,
          );
          setSubtasks((current) => ({
            ...current,
            [subtask.taskId]: (current[subtask.taskId] ?? []).map((item) =>
              item.id === updated.id ? updated : item,
            ),
          }));
        } else {
          const reordered = moveChecklistItem(
            subtasks[subtask.taskId] ?? [],
            subtask.id,
            action,
          );
          if (reordered === undefined) return;
          const updated = await reorderSubtasks(
            subtask.taskId,
            reordered.map(({ id, revision }) => ({ id, revision })),
            state.session.csrfToken,
          );
          setSubtasks((current) => ({
            ...current,
            [subtask.taskId]: updated,
          }));
        }
      }
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

  // Planned day and reminders are online-only edits (ADR 0020).
  const submitTaskPlanning = async (
    task: Task,
    patch: TaskPatchRequest,
  ): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    setFormError(null);
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
              <p className="muted">Opening your suite...</p>
            </div>
          )}
          {state.kind === "error" && (
            <div>
              <p className="step">Connection problem</p>
              <h2>Unable to reach the Suite</h2>
              <p className="muted">{state.message}</p>
              <Button onClick={() => location.reload()}>Retry</Button>
            </div>
          )}
          {state.kind === "setup" && (
            <form onSubmit={(event) => void submitSetup(event)}>
              <p className="step">Step 1 of 2</p>
              <h2>Create the owner account</h2>
              <p className="muted">
                This first release supports one owner. The identity remains
                explicit so future data is always ownership-scoped.
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
              <p className="step">Welcome back</p>
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
              {state.username !== undefined && (
                <p className="message message-error">
                  Session expired. Please sign in again.
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
                Enter the Baikal user you created. The Suite verifies it through
                CalDAV before storing an encrypted credential.
              </p>
              <p className="hint mono">
                Bundled Baikal \u00b7 server-managed CalDAV
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
    <AppShell
      route={route}
      onNavigate={navigate}
      syncStatus={state.syncStatus}
      conflictCount={state.conflictCount}
      baikalConnected={state.baikal.connected}
      formError={formError}
      onSignOut={() => void signOut()}
      commandTrigger={
        <CommandBar
          onNavigate={navigate}
          onSyncNow={() => void syncNow()}
          syncAvailable={networkOnline && state.client !== undefined}
        />
      }
    >
      {recovery}
      <SyncConflictReview
        reviews={state.conflictReviews ?? []}
        busy={busy}
        onResolve={resolveConflict}
      />
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
          onSubmitTask={submitTask}
          onChangeTaskStatus={changeTaskStatus}
          onSubmitTimeBlock={submitTimeBlock}
          onRemoveTimeBlock={removeTimeBlock}
          onViewTasks={() => navigate("tasks")}
          csrfToken={state.session.csrfToken}
          online={networkOnline}
          onTasksPlanned={() => void syncNow()}
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
          csrfToken={state.session.csrfToken}
          online={networkOnline}
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
        />
      )}
    </AppShell>
  );
};
