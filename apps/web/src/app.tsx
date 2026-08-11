import { useCallback, useEffect, useState, type SyntheticEvent } from "react";
import type {
  ActiveSession,
  BaikalStatusResponse,
  Project,
  SessionResponse,
  Subtask,
  Tag,
  Task,
  PlannerResponse,
  ChoicePool,
  ChoicePoolItem,
  ChoicePoolHistoryEvent,
  PlanningPlaceholder,
  ChoicePoolSuggestionResponse,
  TemplatePoolSlot,
  GoogleConnectorStatusResponse,
  PlanningPreferences,
  DayPlanResponse,
  NotificationPreferences,
  NotificationStatusResponse,
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
  login,
  logout,
  putTaskTimeBlock,
  removeTaskTimeBlock,
  resumeSession,
  setupOwner,
} from "./api.ts";
import { LocalStore, type LocalClientIdentity } from "./local-store.ts";
import { SyncEngine, installOnlineSync } from "./sync-engine.ts";
import { FocusPanel, type FocusPanelCommand } from "./focus-panel.tsx";
import {
  TemplateLibrary,
  type TemplateBlueprintView,
  type TemplateSetView,
  type TemplateView,
} from "./template-library.tsx";
import { ChoicePoolLibrary } from "./choice-pool-library.tsx";
import { CalendarMigration } from "./calendar-migration.tsx";
import { GooglePlanning } from "./google-planning.tsx";
import { NotificationSettings } from "./notification-settings.tsx";

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
    }
  | {
      readonly kind: "offline";
      readonly tasks: readonly Task[];
      readonly recovery: readonly Task[];
      readonly conflictCount: number;
      readonly message: string;
    }
  | { readonly kind: "error"; readonly message: string };

export interface AppProps {
  readonly initialState?: AppState;
  readonly initialPath?: string;
}

const workspaceRoutes = [
  "today",
  "tasks",
  "reuse",
  "connections",
  "settings",
] as const;
type WorkspaceRoute = (typeof workspaceRoutes)[number];
const routeFromPath = (path: string): WorkspaceRoute => {
  const candidate = path.replace(/^\//, "").split("/")[0];
  return workspaceRoutes.find((route) => route === candidate) ?? "today";
};

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

const Field = ({
  label,
  name,
  type = "text",
  autoComplete,
  minLength,
  defaultValue,
  required = true,
}: {
  readonly label: string;
  readonly name: string;
  readonly type?: "text" | "password";
  readonly autoComplete: string;
  readonly minLength?: number;
  readonly defaultValue?: string;
  readonly required?: boolean;
}) => (
  <label className="field">
    <span>{label}</span>
    <input
      name={name}
      type={type}
      autoComplete={autoComplete}
      minLength={minLength}
      defaultValue={defaultValue}
      required={required}
    />
  </label>
);

export const App = ({ initialState, initialPath }: AppProps) => {
  const [state, setState] = useState<AppState>(
    initialState ?? { kind: "loading" },
  );
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
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
  const [taskQuery, setTaskQuery] = useState("");
  const [taskStatusFilter, setTaskStatusFilter] = useState<
    "all" | Task["status"]
  >("all");
  const [taskProjectFilter, setTaskProjectFilter] = useState("");
  const [taskTagFilter, setTaskTagFilter] = useState("");
  const [hiddenCalendarIds, setHiddenCalendarIds] = useState<readonly string[]>(
    [],
  );

  useEffect(() => {
    const onPopState = (): void => setRoute(routeFromPath(location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = (next: WorkspaceRoute): void => {
    if (typeof history !== "undefined") history.pushState({}, "", `/${next}`);
    setRoute(next);
  };

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
    [synchronize],
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
          void cachedTaskState()
            .then((cached) => {
              if (
                !cancelled() &&
                (cached.tasks.length > 0 || cached.recovery.length > 0)
              )
                setState({
                  kind: "offline",
                  ...cached,
                  message: "Working from this browser’s durable task cache.",
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
  }, [cachedTaskState, initialState, loadAuthenticated]);

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
        message: "Owner account created. Sign in to connect Baïkal.",
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

  const authorizeGoogle = async (): Promise<string> => {
    if (state.kind !== "authenticated") throw new Error("Sign in required");
    setBusy(true);
    setFormError(null);
    try {
      const authorization = await beginGoogleAuthorization(
        state.session.csrfToken,
      );
      return authorization.authorizationUrl;
    } catch (error: unknown) {
      setFormError(messageFor(error));
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

  const syncGoogleCalendar = async (): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    setFormError(null);
    try {
      await synchronizeGoogle(state.session.csrfToken);
      await refreshGooglePlanning();
    } catch (error: unknown) {
      setFormError(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const removeGoogleCalendar = async (): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    setFormError(null);
    try {
      await disconnectGoogle(state.session.csrfToken);
      await refreshGooglePlanning();
    } catch (error: unknown) {
      setFormError(messageFor(error));
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

  const syncAfterLocalMutation = async (): Promise<void> => {
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
      setFormError(`Saved locally. ${messageFor(error)}`);
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

  const submitTask = async (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ): Promise<void> => {
    event.preventDefault();
    if (state.kind !== "authenticated" && state.kind !== "offline") return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setFormError(null);
    try {
      const estimate = Number(formValue(data, "estimateMinutes"));
      await localStore.queueTaskCreate({
        title: formValue(data, "title"),
        notes: formValue(data, "notes"),
        estimateMinutes:
          Number.isInteger(estimate) && estimate > 0 ? estimate : null,
      });
      await syncAfterLocalMutation();
      form.reset();
    } catch (error: unknown) {
      setFormError(messageFor(error));
    } finally {
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

  const submitTaskEdit = async (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
    task: Task,
  ): Promise<void> => {
    event.preventDefault();
    if (state.kind !== "authenticated") return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setFormError(null);
    try {
      const estimate = Number(formValue(data, "estimateMinutes"));
      await localStore.queueTaskPatch(task.id, {
        title: formValue(data, "title"),
        notes: formValue(data, "notes"),
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
  ): Promise<void> => {
    if (state.kind !== "authenticated" && state.kind !== "offline") return;
    setBusy(true);
    setFormError(null);
    try {
      await localStore.queueTaskStatus(task.id, action === "complete");
      await syncAfterLocalMutation();
    } catch (error: unknown) {
      handleTaskError(error);
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
        const updated = await patchSubtask(
          subtask.id,
          subtask.revision,
          action === "toggle"
            ? { completed: !subtask.completed }
            : {
                position: Math.max(
                  0,
                  subtask.position + (action === "up" ? -1 : 1),
                ),
              },
          state.session.csrfToken,
        );
        setSubtasks((current) => ({
          ...current,
          [subtask.taskId]: (current[subtask.taskId] ?? [])
            .map((item) => (item.id === updated.id ? updated : item))
            .sort((left, right) => left.position - right.position),
        }));
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
      const planner = await getPlanner(window.from, window.to);
      setState((current) =>
        current.kind === "authenticated" ? { ...current, planner } : current,
      );
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
      const planner = await getPlanner(window.from, window.to);
      setState((current) =>
        current.kind === "authenticated" ? { ...current, planner } : current,
      );
    } catch (error: unknown) {
      handleTaskError(error);
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

  return (
    <main className="shell">
      <section className="hero" aria-labelledby="suite-title">
        <p className="eyebrow">Private · self-hosted · calm by default</p>
        <h1 id="suite-title">Productivity Suite</h1>
        <p className="lede">
          One quiet place for tasks, real calendar time, focused work, and
          deliberate automation.
        </p>
        <p className="phase">Single-owner daily driver · Phase 10</p>
      </section>

      <section className="panel" aria-live="polite">
        {state.kind === "loading" && (
          <div className="centered">
            <span className="status__light" aria-hidden="true" />
            <h2>Opening your suite…</h2>
          </div>
        )}

        {state.kind === "error" && (
          <div>
            <p className="step">Connection problem</p>
            <h2>The foundation is unavailable</h2>
            <p className="muted">{state.message}</p>
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
            {formError !== null && <p className="form-error">{formError}</p>}
            <button disabled={busy}>
              {busy ? "Creating…" : "Create owner"}
            </button>
          </form>
        )}

        {state.kind === "login" && (
          <form onSubmit={(event) => void submitLogin(event)}>
            <p className="step">Welcome back</p>
            <h2>Sign in</h2>
            {state.message !== undefined && (
              <p className="success">{state.message}</p>
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
              <p className="hint">Your owner username is {state.username}.</p>
            )}
            {formError !== null && <p className="form-error">{formError}</p>}
            <button disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
          </form>
        )}

        {state.kind === "offline" && (
          <div>
            <p className="step">Offline task cache</p>
            <h2>Keep working locally</h2>
            <p className="success">{state.message}</p>
            <p className="hint">
              Calendar placement and focus control return when this browser
              reconnects. Pending task changes remain in IndexedDB.
            </p>
            <nav className="workspace-nav" aria-label="Offline workspace views">
              {(["today", "tasks"] as const).map((item) => (
                <a
                  key={item}
                  href={`/${item}`}
                  aria-current={route === item ? "page" : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    navigate(item);
                  }}
                >
                  {item === "today" ? "Today" : "Tasks"}
                </a>
              ))}
            </nav>
            <div className="offline-controls" aria-label="Online-only controls">
              <button type="button" disabled>
                Place in calendar (offline)
              </button>
              <button type="button" disabled>
                Start focus (offline)
              </button>
            </div>
            <form
              className="task-capture"
              onSubmit={(event) => void submitTask(event)}
            >
              <Field
                label="What needs doing?"
                name="title"
                autoComplete="off"
              />
              <Field
                label="Notes"
                name="notes"
                autoComplete="off"
                required={false}
              />
              <label className="field">
                <span>Estimate minutes</span>
                <input name="estimateMinutes" type="number" min="1" max="720" />
              </label>
              <button disabled={busy}>Save locally</button>
            </form>
            <ul className="tasks">
              {state.tasks.map((task) => (
                <li key={task.id}>
                  <strong>{task.title}</strong>
                  <span>{task.notes}</span>
                  <form onSubmit={(event) => void submitTaskEdit(event, task)}>
                    <Field
                      label="Title"
                      name="title"
                      autoComplete="off"
                      defaultValue={task.title}
                    />
                    <Field
                      label="Notes"
                      name="notes"
                      autoComplete="off"
                      defaultValue={task.notes}
                      required={false}
                    />
                    <label className="field">
                      <span>Estimate minutes</span>
                      <input
                        name="estimateMinutes"
                        type="number"
                        min="1"
                        max="720"
                        defaultValue={task.estimateMinutes ?? ""}
                      />
                    </label>
                    <button disabled={busy}>Save locally</button>
                  </form>
                  <div className="task-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void changeTaskStatus(
                          task,
                          task.status === "completed" ? "reopen" : "complete",
                        )
                      }
                    >
                      {task.status === "completed" ? "Reopen" : "Complete"}
                    </button>
                    <button
                      type="button"
                      className="danger-button"
                      disabled={busy}
                      onClick={() => void removeTask(task)}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <details className="recovery">
              <summary>Deleted tasks ({state.recovery.length})</summary>
              {state.recovery.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => void recoverTask(task)}
                >
                  Restore {task.title}
                </button>
              ))}
            </details>
            <p className="hint">
              Visible sync conflicts: {state.conflictCount}
            </p>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => void syncNow()}
            >
              Sync now
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => void exportDiagnostics()}
            >
              Export redacted sync diagnostics
            </button>
          </div>
        )}

        {state.kind === "authenticated" && !state.baikal.connected && (
          <form onSubmit={(event) => void submitBaikal(event)}>
            <div className="panel-heading">
              <div>
                <p className="step">Step 2 of 2</p>
                <h2>Connect Baïkal</h2>
              </div>
              <button
                className="text-button"
                type="button"
                onClick={() => void signOut()}
              >
                Sign out
              </button>
            </div>
            <p className="muted">
              Enter the Baïkal user you created. The Suite verifies it through
              CalDAV before storing an encrypted credential.
            </p>
            <p className="endpoint">Bundled Baïkal · server-managed CalDAV</p>
            <Field
              label="Baïkal username"
              name="username"
              autoComplete="username"
            />
            <Field
              label="Baïkal password"
              name="password"
              type="password"
              autoComplete="current-password"
            />
            {formError !== null && <p className="form-error">{formError}</p>}
            <button disabled={busy}>
              {busy ? "Verifying…" : "Verify and connect"}
            </button>
          </form>
        )}

        {state.kind === "authenticated" && state.baikal.connected && (
          <div>
            <div className="panel-heading">
              <div>
                <p className="step">Planner connected</p>
                <h2>Hello, {state.session.owner.displayName}</h2>
              </div>
              <button
                className="text-button"
                type="button"
                onClick={() => void signOut()}
              >
                Sign out
              </button>
            </div>
            <p className="success">
              Baïkal is verified as {state.baikal.username}. Credentials remain
              server-side.
            </p>
            <p
              className="hint"
              data-sync-status={state.syncStatus ?? "offline"}
            >
              Task sync: {state.syncStatus ?? "offline"} · visible conflicts:{" "}
              {state.conflictCount ?? 0}
            </p>
            <nav className="workspace-nav" aria-label="Workspace views">
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
            {route === "connections" &&
              state.google !== undefined &&
              state.planningPreferences !== undefined &&
              state.dayPlan !== undefined && (
                <GooglePlanning
                  mode="connection"
                  status={state.google}
                  preferences={state.planningPreferences}
                  dayPlan={state.dayPlan}
                  busy={busy}
                  onAuthorize={authorizeGoogle}
                  onSynchronize={syncGoogleCalendar}
                  onDisconnect={removeGoogleCalendar}
                  onSavePreferences={savePlanningPreferences}
                />
              )}
            {route === "settings" &&
              state.google !== undefined &&
              state.planningPreferences !== undefined &&
              state.dayPlan !== undefined && (
                <GooglePlanning
                  mode="preferences"
                  status={state.google}
                  preferences={state.planningPreferences}
                  dayPlan={state.dayPlan}
                  busy={busy}
                  onAuthorize={authorizeGoogle}
                  onSynchronize={syncGoogleCalendar}
                  onDisconnect={removeGoogleCalendar}
                  onSavePreferences={savePlanningPreferences}
                />
              )}
            {route === "settings" &&
              state.notificationPreferences !== undefined &&
              state.notificationStatus !== undefined && (
                <NotificationSettings
                  preferences={state.notificationPreferences}
                  status={state.notificationStatus}
                  busy={busy}
                  online={state.syncStatus === "online"}
                  onSave={saveNotificationPreferences}
                  onTest={testNotification}
                />
              )}
            {route === "today" && state.dayPlan !== undefined && (
              <section className="today-status" aria-labelledby="today-title">
                <p className="step">Calm daily workspace</p>
                <h3 id="today-title">
                  {state.dayPlan.state.replaceAll("_", " ")}
                </h3>
                <p>
                  {state.dayPlan.nextTask === null
                    ? "No scheduled task is ready next."
                    : `Next: ${state.dayPlan.nextTask.title}`}
                </p>
                <p className="hint">
                  {state.dayPlan.reminder.suppressed
                    ? `Quiet: ${state.dayPlan.reminder.reason.replaceAll("_", " ")}`
                    : "Ready for the next planned task."}
                </p>
              </section>
            )}
            {route === "settings" && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => void syncNow()}
              >
                Sync now
              </button>
            )}
            {formError !== null && <p className="form-error">{formError}</p>}
            {route === "today" && (
              <>
                <FocusPanel
                  tasks={state.tasks}
                  activeSession={state.activeSession ?? null}
                  clientId={state.client?.clientId ?? null}
                  busy={busy}
                  online={state.syncStatus === "online"}
                  onCommand={(command) => void handleFocusCommand(command)}
                />
                <section
                  className="week-plan"
                  aria-labelledby="week-plan-title"
                >
                  <div className="section-heading">
                    <div>
                      <p className="step">Real calendar context</p>
                      <h3 id="week-plan-title">Week plan</h3>
                    </div>
                    {state.planner !== null && (
                      <span
                        className={`freshness freshness--${state.planner.freshness.state}`}
                      >
                        {state.planner.freshness.message}
                      </span>
                    )}
                  </div>
                  {state.planner === null ||
                  state.planner.events.length === 0 ? (
                    <p className="muted">No supported events in this week.</p>
                  ) : (
                    <>
                      <fieldset className="calendar-filters">
                        <legend>Calendars</legend>
                        {Array.from(
                          new Map(
                            state.planner.events.map((event) => [
                              event.identity.calendarId,
                              event.source,
                            ]),
                          ),
                        ).map(([calendarId, source]) => (
                          <label key={calendarId}>
                            <input
                              type="checkbox"
                              checked={!hiddenCalendarIds.includes(calendarId)}
                              onChange={(event) =>
                                setHiddenCalendarIds((current) =>
                                  event.currentTarget.checked
                                    ? current.filter((id) => id !== calendarId)
                                    : [...current, calendarId],
                                )
                              }
                            />
                            {source.providerDisplayLabel} ·{" "}
                            {source.calendarName}
                          </label>
                        ))}
                      </fieldset>
                      <ol className="timeline">
                        {state.planner.events
                          .filter(
                            (event) =>
                              !hiddenCalendarIds.includes(
                                event.identity.calendarId,
                              ),
                          )
                          .map((event) => (
                            <li
                              key={`${event.identity.calendarId}:${event.href}`}
                            >
                              <time dateTime={event.startsAt}>
                                {new Date(event.startsAt).toLocaleString()}
                              </time>
                              <strong>
                                {event.summary || "Untitled event"}
                              </strong>
                              <span className="source-badge">
                                {event.source.providerDisplayLabel} ·{" "}
                                {event.source.calendarName}
                              </span>
                              <span>
                                until{" "}
                                {new Date(event.endsAt).toLocaleTimeString()}
                              </span>
                            </li>
                          ))}
                      </ol>
                    </>
                  )}
                </section>
                <form
                  className="task-capture"
                  onSubmit={(event) => void submitTask(event)}
                >
                  <h3>Capture a task</h3>
                  <Field
                    label="What needs doing?"
                    name="title"
                    autoComplete="off"
                  />
                  <Field
                    label="Notes"
                    name="notes"
                    autoComplete="off"
                    required={false}
                  />
                  <label className="field">
                    <span>Estimate minutes</span>
                    <input
                      name="estimateMinutes"
                      type="number"
                      min="1"
                      max="720"
                    />
                  </label>
                  <button disabled={busy}>
                    {busy ? "Capturing…" : "Capture task"}
                  </button>
                </form>
              </>
            )}
            {route === "tasks" && (
              <section aria-labelledby="organization-title">
                <h3 id="organization-title">Projects and tags</h3>
                <div className="task-actions">
                  <form
                    onSubmit={(event) =>
                      void submitOrganization(event, "project")
                    }
                  >
                    <Field
                      label="New project"
                      name="title"
                      autoComplete="off"
                    />
                    <button disabled={busy}>Add project</button>
                  </form>
                  <form
                    onSubmit={(event) => void submitOrganization(event, "tag")}
                  >
                    <Field label="New tag" name="title" autoComplete="off" />
                    <button disabled={busy}>Add tag</button>
                  </form>
                </div>
              </section>
            )}
            {route === "reuse" && (
              <TemplateLibrary
                templates={templates}
                blueprints={templateBlueprints}
                sets={templateSets}
                projects={projects
                  .filter((project) => project.archivedAt === null)
                  .map(({ id, title }) => ({ id, title }))}
                tags={tags
                  .filter((tag) => tag.archivedAt === null)
                  .map(({ id, displayName }) => ({ id, displayName }))}
                busy={busy}
                onCreate={submitTemplateCreate}
                onSearch={(query) => void refreshTemplateLibrary(query)}
                onArchive={archiveTemplate}
                onEdit={editTemplate}
                onCreateSet={submitTemplateSetCreate}
                onInstantiate={submitTemplateInstantiation}
                onInstantiateSet={submitTemplateSetInstantiation}
              />
            )}
            {route === "reuse" && (
              <ChoicePoolLibrary
                pools={choicePools}
                items={choicePoolItems}
                history={choicePoolHistory}
                placeholders={planningPlaceholders}
                tasks={state.tasks}
                templates={templates}
                poolSlots={templatePoolSlots}
                busy={busy}
                onCreatePool={submitChoicePool}
                onCreatePlaceholder={submitPlanningPlaceholder}
                onEditPool={editChoicePool}
                onCreateTemplateSlot={addTemplatePoolSlot}
                onRecordCompletion={completeChoicePoolItem}
                onSuggest={previewPlanningPlaceholder}
                onResolve={submitPlaceholderResolution}
              />
            )}
            {route === "tasks" && (
              <>
                <div
                  className="task-filter-bar"
                  role="search"
                  aria-label="Filter tasks"
                >
                  <label>
                    Search
                    <input
                      type="search"
                      value={taskQuery}
                      onChange={(event) =>
                        setTaskQuery(event.currentTarget.value)
                      }
                    />
                  </label>
                  <label>
                    Status
                    <select
                      value={taskStatusFilter}
                      onChange={(event) =>
                        setTaskStatusFilter(
                          event.currentTarget.value as "all" | Task["status"],
                        )
                      }
                    >
                      <option value="all">All</option>
                      <option value="open">Open</option>
                      <option value="completed">Completed</option>
                    </select>
                  </label>
                  <label>
                    Project
                    <select
                      value={taskProjectFilter}
                      onChange={(event) =>
                        setTaskProjectFilter(event.currentTarget.value)
                      }
                    >
                      <option value="">All projects</option>
                      {projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Tag
                    <select
                      value={taskTagFilter}
                      onChange={(event) =>
                        setTaskTagFilter(event.currentTarget.value)
                      }
                    >
                      <option value="">All tags</option>
                      {tags.map((tag) => (
                        <option key={tag.id} value={tag.id}>
                          {tag.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <h3>Captured tasks</h3>
                {visibleTasks.length === 0 ? (
                  <p className="muted">No tasks match these filters.</p>
                ) : (
                  <ul className="tasks">
                    {visibleTasks.map((task) => (
                      <li
                        key={task.id}
                        className={
                          task.status === "completed" ? "task--completed" : ""
                        }
                      >
                        <div className="task-heading">
                          <strong>{task.title}</strong>
                          <small>
                            {task.status === "completed" ? "Completed" : "Open"}{" "}
                            · Revision {task.revision}
                          </small>
                        </div>
                        {task.notes !== "" && <span>{task.notes}</span>}
                        {templateProvenance[task.id] !== undefined && (
                          <p className="template-provenance">
                            Created from a reusable template.
                          </p>
                        )}
                        {task.plannedStart != null && (
                          <p className="planned-time">
                            Planned{" "}
                            {new Date(task.plannedStart).toLocaleString()} ·{" "}
                            {task.estimateMinutes} minutes
                          </p>
                        )}
                        <form
                          className="task-edit"
                          onSubmit={(event) => void submitTaskEdit(event, task)}
                        >
                          <Field
                            label="Title"
                            name="title"
                            autoComplete="off"
                            defaultValue={task.title}
                          />
                          <Field
                            label="Notes"
                            name="notes"
                            autoComplete="off"
                            defaultValue={task.notes}
                            required={false}
                          />
                          <label className="field">
                            <span>Estimate minutes</span>
                            <input
                              name="estimateMinutes"
                              type="number"
                              min="1"
                              max="720"
                              defaultValue={task.estimateMinutes ?? ""}
                            />
                          </label>
                          <button disabled={busy}>Save task</button>
                        </form>
                        <form
                          className="time-block"
                          onSubmit={(event) =>
                            void submitTimeBlock(event, task)
                          }
                        >
                          <label className="field">
                            <span>Calendar</span>
                            <select name="calendarId" required>
                              {state.baikal.calendars
                                .filter((calendar) => calendar.supportsEvents)
                                .map((calendar) => (
                                  <option key={calendar.id} value={calendar.id}>
                                    {calendar.displayName}
                                  </option>
                                ))}
                            </select>
                          </label>
                          <label className="field">
                            <span>Start</span>
                            <input
                              name="startsAt"
                              type="datetime-local"
                              required
                            />
                          </label>
                          <label className="field">
                            <span>Minutes</span>
                            <input
                              name="durationMinutes"
                              type="number"
                              min="1"
                              max="720"
                              defaultValue={task.estimateMinutes ?? 30}
                              required
                            />
                          </label>
                          <p className="hint">
                            Manual placement stays explicit even when times
                            overlap.
                          </p>
                          <button disabled={busy}>
                            {task.plannedStart == null
                              ? "Place in calendar"
                              : "Move calendar block"}
                          </button>
                          {task.plannedStart != null && (
                            <button
                              type="button"
                              className="text-button"
                              disabled={busy}
                              onClick={() => void removeTimeBlock(task)}
                            >
                              Remove calendar block
                            </button>
                          )}
                        </form>
                        <form
                          className="task-edit"
                          onSubmit={(event) =>
                            void submitTaskOrganization(event, task)
                          }
                        >
                          <label className="field">
                            <span>Project</span>
                            <select
                              name="projectId"
                              defaultValue={task.projectId ?? ""}
                            >
                              <option value="">No project</option>
                              {projects
                                .filter(
                                  (project) => project.archivedAt === null,
                                )
                                .map((project) => (
                                  <option key={project.id} value={project.id}>
                                    {project.title}
                                  </option>
                                ))}
                            </select>
                          </label>
                          <fieldset>
                            <legend>Tags</legend>
                            {tags
                              .filter((tag) => tag.archivedAt === null)
                              .map((tag) => (
                                <label key={tag.id}>
                                  <input
                                    type="checkbox"
                                    name="tagIds"
                                    value={tag.id}
                                    defaultChecked={task.tagIds?.includes(
                                      tag.id,
                                    )}
                                  />
                                  {tag.displayName}
                                </label>
                              ))}
                          </fieldset>
                          <button disabled={busy}>Save organization</button>
                        </form>
                        <div>
                          <strong>Checklist</strong>
                          <ul>
                            {(subtasks[task.id] ?? []).map((subtask) => (
                              <li key={subtask.id}>
                                {subtask.completed ? "✓" : "○"} {subtask.title}
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() =>
                                    void changeSubtask(subtask, "toggle")
                                  }
                                >
                                  {subtask.completed ? "Reopen" : "Complete"}
                                </button>
                                <button
                                  type="button"
                                  disabled={busy || subtask.position === 0}
                                  onClick={() =>
                                    void changeSubtask(subtask, "up")
                                  }
                                >
                                  Move up
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() =>
                                    void changeSubtask(subtask, "down")
                                  }
                                >
                                  Move down
                                </button>
                                <button
                                  type="button"
                                  className="danger-button"
                                  disabled={busy}
                                  onClick={() =>
                                    void changeSubtask(subtask, "delete")
                                  }
                                >
                                  Delete item
                                </button>
                              </li>
                            ))}
                          </ul>
                          <form
                            onSubmit={(event) =>
                              void submitSubtask(event, task)
                            }
                          >
                            <Field
                              label="New checklist item"
                              name="title"
                              autoComplete="off"
                            />
                            <button disabled={busy}>Add item</button>
                          </form>
                        </div>
                        <div className="task-actions">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void saveTaskAsTemplate(task)}
                          >
                            Save as template
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void changeTaskStatus(
                                task,
                                task.status === "completed"
                                  ? "reopen"
                                  : "complete",
                              )
                            }
                          >
                            {task.status === "completed"
                              ? "Reopen"
                              : "Complete"}
                          </button>
                          <button
                            className="danger-button"
                            type="button"
                            disabled={busy}
                            onClick={() => void removeTask(task)}
                          >
                            Delete
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <details className="recovery">
                  <summary>
                    Recently deleted tasks ({state.recovery.length})
                  </summary>
                  {state.recovery.length === 0 ? (
                    <p className="muted">Nothing needs recovery.</p>
                  ) : (
                    <ul className="tasks">
                      {state.recovery.map((task) => (
                        <li key={task.id}>
                          <strong>{task.title}</strong>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void recoverTask(task)}
                          >
                            Restore task
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              </>
            )}
            {route === "settings" && (
              <section aria-labelledby="settings-health-title">
                <h3 id="settings-health-title">Client and service health</h3>
                <dl className="settings-health">
                  <div>
                    <dt>Task sync</dt>
                    <dd>{state.syncStatus ?? "offline"}</dd>
                  </div>
                  <div>
                    <dt>Client</dt>
                    <dd>{state.client?.clientId ?? "Not registered"}</dd>
                  </div>
                  <div>
                    <dt>Calendar freshness</dt>
                    <dd>{state.planner?.freshness.state ?? "unavailable"}</dd>
                  </div>
                </dl>
                <p className="hint">
                  Automation credentials remain separately scoped and revocable;
                  connector secrets are never returned to this page.
                </p>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => void exportDiagnostics()}
                >
                  Export redacted sync diagnostics
                </button>
              </section>
            )}
            {route === "connections" && (
              <section aria-labelledby="connections-calendars-title">
                <h3 id="connections-calendars-title">Discovered calendars</h3>
                {state.baikal.calendars.length === 0 ? (
                  <p className="muted">
                    No calendar collections were returned.
                  </p>
                ) : (
                  <ul className="calendars">
                    {state.baikal.calendars.map((calendar) => (
                      <li key={calendar.href}>
                        <strong>{calendar.displayName}</strong>
                        <span>
                          {[
                            calendar.supportsEvents ? "Events" : null,
                            calendar.supportsTodos ? "Todos" : null,
                          ]
                            .filter(Boolean)
                            .join(" · ") || "No supported component reported"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <CalendarMigration
                  calendars={state.baikal.calendars}
                  csrfToken={state.session.csrfToken}
                />
                <p className="boundary-note">
                  Calendar reads and Suite-created time blocks are conditional
                  and bounded. Calendar and focus mutations remain online-only
                  and are never silently queued.
                </p>
              </section>
            )}
          </div>
        )}
      </section>
    </main>
  );
};
