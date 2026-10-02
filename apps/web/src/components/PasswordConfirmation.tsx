import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { confirmPassword } from "../api.ts";
import { registerReauthenticationPrompt } from "../reauthentication.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/**
 * Asks for the owner's password when a trusted device attempts a sensitive
 * action (ADR 0048). The API client waits for the answer and repeats the
 * refused request; closing the dialog leaves the action undone.
 */
export const PasswordConfirmation = ({
  csrfToken,
}: {
  readonly csrfToken: string;
}) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = useRef<((confirmed: boolean) => void) | null>(null);

  const finish = (confirmed: boolean): void => {
    answer.current?.(confirmed);
    answer.current = null;
    setOpen(false);
    setError(null);
  };

  useEffect(() => {
    const unregister = registerReauthenticationPrompt(
      () =>
        new Promise<boolean>((resolve) => {
          answer.current = resolve;
          setOpen(true);
        }),
    );
    return () => {
      unregister();
      answer.current?.(false);
      answer.current = null;
    };
  }, []);

  const submit = async (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ): Promise<void> => {
    event.preventDefault();
    const password = new FormData(event.currentTarget).get("password");
    setBusy(true);
    setError(null);
    try {
      await confirmPassword(
        typeof password === "string" ? password : "",
        csrfToken,
      );
      finish(true);
    } catch (failure: unknown) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The password could not be confirmed.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) finish(false);
      }}
    >
      <DialogContent aria-describedby="password-confirmation-description">
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Confirm your password</DialogTitle>
            <DialogDescription id="password-confirmation-description">
              This device stays signed in, so changes to connections, assistant
              access, calendar feeds, devices and data export or restore need
              your password again. The confirmation lasts 15 minutes.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="password-confirmation-input">
              Password
            </FieldLabel>
            <Input
              id="password-confirmation-input"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              autoFocus
            />
            <FieldError>{error}</FieldError>
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => finish(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Confirming…" : "Confirm"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
