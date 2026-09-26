import type { FocusIdleDisposition } from "@suite/contracts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatCountdown } from "./focus-timer.ts";

export interface IdleReturnDialogProps {
  readonly open: boolean;
  readonly idleStartedAt: string | null;
  readonly returnedAt: string | null;
  readonly taskTitle: string | null;
  readonly phase: "focus" | "break" | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onChoose: (disposition: FocusIdleDisposition) => void;
}

/**
 * Asks the owner what an idle span was (ADR 0029). Nothing is changed until a
 * choice is made; the session keeps running meanwhile. There is no close
 * control: the dialog stays until one of the three choices is applied.
 */
export const IdleReturnDialog = ({
  open,
  idleStartedAt,
  returnedAt,
  taskTitle,
  phase,
  busy,
  error,
  onChoose,
}: IdleReturnDialogProps) => {
  const spanMs =
    idleStartedAt === null || returnedAt === null
      ? 0
      : Math.max(0, Date.parse(returnedAt) - Date.parse(idleStartedAt));
  const since =
    idleStartedAt === null
      ? ""
      : new Date(idleStartedAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
  return (
    <Dialog open={open}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        aria-describedby="idle-return-description"
      >
        <DialogHeader>
          <DialogTitle>You were away for {formatCountdown(spanMs)}</DialogTitle>
          <DialogDescription id="idle-return-description">
            No input since {since}
            {taskTitle === null ? "" : ` while tracking "${taskTitle}"`}. The
            session kept running. Choose what that time was; no time is added
            either way.
          </DialogDescription>
        </DialogHeader>
        {error === null ? null : (
          <p className="message message-error" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onChoose("discard")}
          >
            Discard the time
          </Button>
          {phase === "break" ? null : (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onChoose("break")}
            >
              Count it as a break
            </Button>
          )}
          <Button
            type="button"
            disabled={busy}
            autoFocus
            onClick={() => onChoose("assign")}
          >
            Keep it as task time
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
