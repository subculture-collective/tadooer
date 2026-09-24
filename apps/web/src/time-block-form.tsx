import type { SyntheticEvent } from "react";
import type { BaikalStatusResponse, Task } from "@suite/contracts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { NativeSelect } from "./components/ui/native-select.tsx";

export interface TimeBlockFormProps {
  readonly task: Task;
  readonly calendars: BaikalStatusResponse["calendars"];
  readonly busy: boolean;
  readonly available: boolean;
  readonly onSubmit: (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
    task: Task,
  ) => Promise<void>;
  readonly onRemove: (task: Task) => Promise<void>;
  readonly defaultCalendarId?: string;
  readonly defaultStartsAt?: string;
  readonly defaultDurationMinutes?: number;
  readonly startLabel?: string;
}

export const TimeBlockForm = ({
  task,
  calendars,
  busy,
  available,
  onSubmit,
  onRemove,
  defaultCalendarId,
  defaultStartsAt,
  defaultDurationMinutes,
  startLabel = "Start",
}: TimeBlockFormProps) => {
  const disabled = busy || !available;
  return (
    <form
      className="time-block"
      onSubmit={(event) => void onSubmit(event, task)}
    >
      {!available ? (
        <p className="hint">Reconnect to change calendar blocks.</p>
      ) : null}
      <label className="field">
        <span>Calendar</span>
        <NativeSelect
          name="calendarId"
          required
          disabled={disabled}
          defaultValue={defaultCalendarId}
        >
          {calendars
            .filter((calendar) => calendar.supportsEvents)
            .map((calendar) => (
              <option key={calendar.id} value={calendar.id}>
                {calendar.displayName}
              </option>
            ))}
        </NativeSelect>
      </label>
      <label className="field">
        <span>{startLabel}</span>
        <Input
          name="startsAt"
          type="datetime-local"
          defaultValue={defaultStartsAt}
          required
          disabled={disabled}
        />
      </label>
      <label className="field">
        <span>Minutes</span>
        <Input
          name="durationMinutes"
          type="number"
          min="1"
          max="720"
          defaultValue={defaultDurationMinutes ?? task.estimateMinutes ?? 30}
          required
          disabled={disabled}
        />
      </label>
      <p className="hint">
        Manual placement stays explicit even when times overlap.
      </p>
      <Button disabled={disabled}>
        {task.plannedStart == null ? "Schedule" : "Move calendar block"}
      </Button>
      {task.plannedStart != null ? (
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => void onRemove(task)}
        >
          Remove calendar block
        </Button>
      ) : null}
    </form>
  );
};
