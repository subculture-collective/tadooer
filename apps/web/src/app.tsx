import { useCallback, useEffect, useState, type SyntheticEvent } from "react";
import type {
  BaikalStatusResponse,
  SessionResponse,
  Task,
} from "@suite/contracts";
import {
  ApiRequestError,
  connectBaikal,
  createTask,
  getBaikalStatus,
  getSetupStatus,
  getTasks,
  login,
  logout,
  resumeSession,
  setupOwner,
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
    const [baikal, taskList] = await Promise.all([
      getBaikalStatus(),
      getTasks(),
    ]);
    setState({ kind: "authenticated", session, baikal, tasks: taskList.tasks });
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
      const baikal = await connectBaikal(
        {
          username: formValue(data, "username"),
          password: formValue(data, "password"),
        },
        state.session.csrfToken,
      );
      setState({ ...state, baikal });
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
      setState({ ...state, tasks: [result.task, ...state.tasks] });
      form.reset();
    } catch (error: unknown) {
      setFormError(messageFor(error));
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
        <p className="phase">Contract lab · Phase 0C</p>
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
                <p className="step">Foundation connected</p>
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
              {formError !== null && <p className="form-error">{formError}</p>}
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
                  <li key={task.id}>
                    <strong>{task.title}</strong>
                    {task.notes !== "" && <span>{task.notes}</span>}
                    <small>Revision {task.revision}</small>
                  </li>
                ))}
              </ul>
            )}
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
              Task capture and calendar discovery are active. Task editing and
              calendar event reads or writes remain Phase 1 capabilities.
            </p>
          </div>
        )}
      </section>
    </main>
  );
};
