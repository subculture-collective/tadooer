import type { SyntheticEvent } from "react";
import type { BaikalStatusResponse, Task } from "@suite/contracts";

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
}

export const TimeBlockForm = ({
  task,
  calendars,
  busy,
  available,
  onSubmit,
  onRemove,
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
        <select name="calendarId" required disabled={disabled}>
          {calendars
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
          disabled={disabled}
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
          disabled={disabled}
        />
      </label>
      <p className="hint">
        Manual placement stays explicit even when times overlap.
      </p>
      <button disabled={disabled}>
        {task.plannedStart == null ? "Schedule" : "Move calendar block"}
      </button>
      {task.plannedStart != null ? (
        <button
          type="button"
          className="btn-ghost"
          disabled={disabled}
          onClick={() => void onRemove(task)}
        >
          Remove calendar block
        </button>
      ) : null}
    </form>
  );
};
