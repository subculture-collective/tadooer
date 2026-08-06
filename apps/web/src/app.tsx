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
} from "@suite/contracts";
import {
  ApiRequestError,
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
  getActiveSession,
  getSetupStatus,
  getTasks,
  getPlanner,
  getProjects,
  getRecoveryTasks,
  getSubtasks,
  getTags,
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

export const App = ({ initialState }: AppProps) => {
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
      const [baikal, taskList, recoveryList, projectList, tagList] =
        await Promise.all([
          getBaikalStatus(),
          getTasks(),
          getRecoveryTasks(),
          getProjects(),
          getTags(),
        ]);
      setProjects(projectList);
      setTags(tagList);
      const window = plannerWindow();
      const planner = baikal.connected
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
        <p className="phase">Local-first focus · Phase 2</p>
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
            {formError !== null && <p className="form-error">{formError}</p>}
            <FocusPanel
              tasks={state.tasks}
              activeSession={state.activeSession ?? null}
              clientId={state.client?.clientId ?? null}
              busy={busy}
              online={state.syncStatus === "online"}
              onCommand={(command) => void handleFocusCommand(command)}
            />
            <section className="week-plan" aria-labelledby="week-plan-title">
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
              {state.planner === null || state.planner.events.length === 0 ? (
                <p className="muted">No supported events in this week.</p>
              ) : (
                <ol className="timeline">
                  {state.planner.events.map((event) => (
                    <li key={`${event.identity.calendarId}:${event.href}`}>
                      <time dateTime={event.startsAt}>
                        {new Date(event.startsAt).toLocaleString()}
                      </time>
                      <strong>{event.summary || "Untitled event"}</strong>
                      <span>
                        until {new Date(event.endsAt).toLocaleTimeString()}
                      </span>
                    </li>
                  ))}
                </ol>
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
                <input name="estimateMinutes" type="number" min="1" max="720" />
              </label>
              <button disabled={busy}>
                {busy ? "Capturing…" : "Capture task"}
              </button>
            </form>
            <section aria-labelledby="organization-title">
              <h3 id="organization-title">Projects and tags</h3>
              <div className="task-actions">
                <form
                  onSubmit={(event) =>
                    void submitOrganization(event, "project")
                  }
                >
                  <Field label="New project" name="title" autoComplete="off" />
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
            <h3>Captured tasks</h3>
            {state.tasks.length === 0 ? (
              <p className="muted">No tasks captured yet.</p>
            ) : (
              <ul className="tasks">
                {state.tasks.map((task) => (
                  <li
                    key={task.id}
                    className={
                      task.status === "completed" ? "task--completed" : ""
                    }
                  >
                    <div className="task-heading">
                      <strong>{task.title}</strong>
                      <small>
                        {task.status === "completed" ? "Completed" : "Open"} ·
                        Revision {task.revision}
                      </small>
                    </div>
                    {task.notes !== "" && <span>{task.notes}</span>}
                    {task.plannedStart != null && (
                      <p className="planned-time">
                        Planned {new Date(task.plannedStart).toLocaleString()} ·{" "}
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
                      onSubmit={(event) => void submitTimeBlock(event, task)}
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
                        <input name="startsAt" type="datetime-local" required />
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
                        Manual placement stays explicit even when times overlap.
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
                            .filter((project) => project.archivedAt === null)
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
                                defaultChecked={task.tagIds?.includes(tag.id)}
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
                              onClick={() => void changeSubtask(subtask, "up")}
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
                        onSubmit={(event) => void submitSubtask(event, task)}
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
            <button
              type="button"
              className="text-button"
              onClick={() => void exportDiagnostics()}
            >
              Export redacted sync diagnostics
            </button>
            <h3>Discovered calendars</h3>
            {state.baikal.calendars.length === 0 ? (
              <p className="muted">No calendar collections were returned.</p>
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
            <p className="boundary-note">
              Calendar reads and Suite-created time blocks are conditional and
              bounded. Recurrence editing, offline writes, Google, and broad
              calendar mutation remain later-phase capabilities.
            </p>
          </div>
        )}
      </section>
    </main>
  );
};
