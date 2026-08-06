import { useCallback, useEffect, useState, type SyntheticEvent } from "react";
import type {
  BaikalStatusResponse,
  SessionResponse,
  Task,
  PlannerResponse,
} from "@suite/contracts";
import {
  ApiRequestError,
  connectBaikal,
  createTask,
  deleteTask,
  getBaikalStatus,
  getSetupStatus,
  getTasks,
  getPlanner,
  getRecoveryTasks,
  login,
  logout,
  patchTask,
  putTaskTimeBlock,
  removeTaskTimeBlock,
  restoreTask,
  resumeSession,
  setupOwner,
  transitionTask,
} from "./api.ts";

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

  const loadAuthenticated = useCallback(async (session: SessionResponse) => {
    const [baikal, taskList, recoveryList] = await Promise.all([
      getBaikalStatus(),
      getTasks(),
      getRecoveryTasks(),
    ]);
    const window = plannerWindow();
    const planner = baikal.connected
      ? await getPlanner(window.from, window.to)
      : null;
    setState({
      kind: "authenticated",
      session,
      baikal,
      tasks: taskList.tasks,
      recovery: recoveryList.tasks,
      planner,
    });
  }, []);

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
          setState({ kind: "error", message: messageFor(error) });
      });
    return () => {
      lifecycle.cancelled = true;
    };
  }, [initialState, loadAuthenticated]);

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

  const submitTask = async (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ): Promise<void> => {
    event.preventDefault();
    if (state.kind !== "authenticated") return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setFormError(null);
    try {
      const result = await createTask(
        { title: formValue(data, "title"), notes: formValue(data, "notes") },
        state.session.csrfToken,
        crypto.randomUUID(),
      );
      setState({
        ...state,
        tasks: [result.task, ...state.tasks],
        planner:
          state.planner === null
            ? null
            : {
                ...state.planner,
                tasks: [result.task, ...state.planner.tasks],
              },
      });
      form.reset();
    } catch (error: unknown) {
      setFormError(messageFor(error));
    } finally {
      setBusy(false);
    }
  };

  const replaceTask = (task: Task): void => {
    if (state.kind !== "authenticated") return;
    setState({
      ...state,
      tasks: state.tasks.map((candidate) =>
        candidate.id === task.id ? task : candidate,
      ),
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
      const result = await patchTask(
        task.id,
        task.revision,
        {
          title: formValue(data, "title"),
          notes: formValue(data, "notes"),
        },
        state.session.csrfToken,
      );
      replaceTask(result.task);
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
    if (state.kind !== "authenticated") return;
    setBusy(true);
    setFormError(null);
    try {
      const result = await transitionTask(
        task.id,
        task.revision,
        action,
        state.session.csrfToken,
      );
      replaceTask(result.task);
    } catch (error: unknown) {
      handleTaskError(error);
    } finally {
      setBusy(false);
    }
  };

  const removeTask = async (task: Task): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    setFormError(null);
    try {
      const result = await deleteTask(
        task.id,
        task.revision,
        state.session.csrfToken,
      );
      setState({
        ...state,
        tasks: state.tasks.filter((candidate) => candidate.id !== task.id),
        recovery: [result.task, ...state.recovery],
        planner:
          state.planner === null
            ? null
            : {
                ...state.planner,
                tasks: state.planner.tasks.filter(
                  (candidate) => candidate.id !== task.id,
                ),
              },
      });
    } catch (error: unknown) {
      handleTaskError(error);
    } finally {
      setBusy(false);
    }
  };

  const recoverTask = async (task: Task): Promise<void> => {
    if (state.kind !== "authenticated") return;
    setBusy(true);
    setFormError(null);
    try {
      const result = await restoreTask(
        task.id,
        task.revision,
        state.session.csrfToken,
      );
      setState({
        ...state,
        tasks: [result.task, ...state.tasks],
        recovery: state.recovery.filter(
          (candidate) => candidate.id !== task.id,
        ),
      });
    } catch (error: unknown) {
      handleTaskError(error);
    } finally {
      setBusy(false);
    }
  };

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

  return (
    <main className="shell">
      <section className="hero" aria-labelledby="suite-title">
        <p className="eyebrow">Private · self-hosted · calm by default</p>
        <h1 id="suite-title">Productivity Suite</h1>
        <p className="lede">
          One quiet place for tasks, real calendar time, focused work, and
          deliberate automation.
        </p>
        <p className="phase">Self-hosted planning · Phase 1</p>
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
            {formError !== null && <p className="form-error">{formError}</p>}
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
              <button disabled={busy}>
                {busy ? "Capturing…" : "Capture task"}
              </button>
            </form>
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
