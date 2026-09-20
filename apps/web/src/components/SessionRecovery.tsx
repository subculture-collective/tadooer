import { useState, type SyntheticEvent } from "react";
import type { SessionResponse } from "@suite/contracts";
import { login, resumeSession } from "../api.ts";
import type { SessionFailure } from "../session-recovery.ts";

export const SessionRecovery = ({
  failure,
  username,
  onRecovered,
}: {
  readonly failure: SessionFailure;
  readonly username: string;
  readonly onRecovered: (session: SessionResponse) => void;
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recover = async (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const session =
        failure === "csrf"
          ? await resumeSession()
          : await login({
              username,
              password:
                typeof data.get("password") === "string"
                  ? (data.get("password") as string)
                  : "",
            });
      onRecovered(session);
    } catch (error: unknown) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to recover the session.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Session recovery" className="message message-error">
      <h2>
        {failure === "expired" ? "Sign in again" : "Refresh your session"}
      </h2>
      <p>
        Your workspace and queued work have been kept. Recover your session,
        then review the result before retrying your action.
      </p>
      <form onSubmit={(event) => void recover(event)}>
        <p>Signed in as {username}</p>
        {failure === "expired" && (
          <label>
            Password{" "}
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
        )}
        <button type="submit" disabled={busy}>
          {busy
            ? "Recovering…"
            : failure === "expired"
              ? "Sign in again"
              : "Refresh session"}
        </button>
        {error !== null && <p role="alert">{error}</p>}
      </form>
    </section>
  );
};
