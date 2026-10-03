import { useState, type SyntheticEvent } from "react";
import {
  trustedDeviceSessionDays,
  type SessionResponse,
} from "@suite/contracts";
import { login, resumeSession } from "../api.ts";
import { desktopShellBridge } from "../desktop-shell.ts";
import type { SessionFailure } from "../session-recovery.ts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

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
              trustDevice: data.get("trustDevice") === "on",
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
    <Alert
      aria-label="Session recovery"
      variant="destructive"
      className="message message-error"
    >
      <AlertTitle>
        {failure === "expired" ? "Sign in again" : "Refresh your session"}
      </AlertTitle>
      <AlertDescription>
        <p>
          Your tasks and queued changes are kept. Enter your password, then
          check the result before you repeat the action.
        </p>
        <form onSubmit={(event) => void recover(event)}>
          <p>Signed in as {username}</p>
          {failure === "expired" && (
            <Field>
              <FieldLabel htmlFor="session-recovery-password">
                Password
              </FieldLabel>
              <Input
                id="session-recovery-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </Field>
          )}
          {failure === "expired" && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="trustDevice"
                defaultChecked={desktopShellBridge() !== undefined}
              />
              Keep me signed in on this device for{" "}
              {String(trustedDeviceSessionDays)} days
            </label>
          )}
          <Button type="submit" disabled={busy}>
            {busy
              ? "Recovering…"
              : failure === "expired"
                ? "Sign in again"
                : "Refresh session"}
          </Button>
          <FieldError>{error}</FieldError>
        </form>
      </AlertDescription>
    </Alert>
  );
};
