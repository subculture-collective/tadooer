import { useState } from "react";
import {
  taskPatchRequestSchema,
  type Task,
  type TaskPatchRequest,
} from "@suite/contracts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { NativeSelect } from "../ui/native-select.tsx";

const offsetLabel = (minutes: number): string =>
  minutes === 0
    ? "At the time"
    : minutes === 60
      ? "1 hour before"
      : `${String(minutes)} minutes before`;

const offsets = [0, 5, 10, 15, 30, 60] as const;

const startReminderValue = (task: Task): string =>
  task.startReminder === undefined || task.startReminder.kind === "default"
    ? "default"
    : task.startReminder.kind === "none"
      ? "none"
      : String(task.startReminder.minutes);

const localInputToIso = (value: string): string | null => {
  if (value === "") return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()))
    throw new Error("Choose a valid planned time.");
  return parsed.toISOString();
};

const isoToLocalInput = (value: string | null | undefined): string => {
  if (value == null) return "";
  const date = new Date(value);
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/**
 * Parse the planning form into a task patch. A planned day and a planned
 * time are exclusive (ADR 0020); the schema rejects both at once.
 */
export const taskPlanningPatchFromForm = (data: FormData): TaskPatchRequest => {
  const text = (name: string): string => {
    const value = data.get(name);
    return typeof value === "string" ? value : "";
  };
  const reminder = text("startReminder");
  const deadlineReminder = text("deadlineReminder");
  return taskPatchRequestSchema.parse({
    plannedDay: text("plannedDay") === "" ? null : text("plannedDay"),
    plannedStart: localInputToIso(text("plannedStart")),
    startReminder:
      reminder === "default" || reminder === "none" || reminder === ""
        ? { kind: reminder === "" ? "default" : reminder }
        : { kind: "before_start", minutes: Number(reminder) },
    deadlineReminder:
      deadlineReminder === "" || deadlineReminder === "none"
        ? null
        : { minutes: Number(deadlineReminder) },
  });
};

export interface TaskPlanningFormProps {
  readonly task: Task;
  readonly timeZone: string;
  readonly busy: boolean;
  readonly available: boolean;
  /**
   * Reminder settings are online-only (ADR 0020); a planned day or time can
   * queue offline (ADR 0033). Defaults to `available`.
   */
  readonly remindersAvailable?: boolean;
  readonly onSubmit: (task: Task, patch: TaskPatchRequest) => Promise<void>;
}

export const TaskPlanningForm = ({
  task,
  timeZone,
  busy,
  available,
  remindersAvailable = available,
  onSubmit,
}: TaskPlanningFormProps) => {
  const [error, setError] = useState<string | null>(null);
  const disabled = busy || !available;
  const remindersDisabled = busy || !remindersAvailable;
  const timedDeadline = task.deadline?.kind === "instant";
  return (
    <form
      className="task-edit task-planning"
      aria-label={`Planning and reminders for “${task.title}”`}
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        let patch: TaskPatchRequest;
        try {
          patch = taskPlanningPatchFromForm(new FormData(event.currentTarget));
        } catch (cause: unknown) {
          setError(
            cause instanceof Error && !cause.message.startsWith("[")
              ? cause.message
              : "Plan a day or an exact time, not both.",
          );
          return;
        }
        void onSubmit(task, patch);
      }}
    >
      {!available ? (
        <p className="hint">Reconnect to change planning.</p>
      ) : !remindersAvailable ? (
        <p className="hint">
          Offline: the planned day or time is saved locally and syncs later.
          Reminder changes need a connection because the server sends them.
        </p>
      ) : null}
      {error !== null && <p className="message message-error">{error}</p>}
      <label className="field">
        <span>Planned day ({timeZone})</span>
        <Input
          name="plannedDay"
          type="date"
          defaultValue={task.plannedDay ?? ""}
          disabled={disabled}
        />
      </label>
      <label className="field">
        <span>Planned time (this device)</span>
        <Input
          name="plannedStart"
          type="datetime-local"
          defaultValue={isoToLocalInput(task.plannedStart)}
          disabled={disabled}
        />
      </label>
      {task.plannedStart != null ? (
        <p className="hint">
          Choosing a day replaces the exact time. A task with a calendar block
          keeps its calendar time; change or remove the block from the planner.
        </p>
      ) : null}
      <label className="field">
        <span>Start reminder</span>
        <NativeSelect
          name="startReminder"
          defaultValue={startReminderValue(task)}
          disabled={remindersDisabled}
        >
          <option value="default">Use notification settings</option>
          <option value="none">No reminder</option>
          {offsets.map((minutes) => (
            <option key={minutes} value={String(minutes)}>
              {offsetLabel(minutes)}
            </option>
          ))}
        </NativeSelect>
      </label>
      <p className="hint">
        Start reminders need an exact start; a planned day has no reminder time.
      </p>
      <label className="field">
        <span>Deadline reminder</span>
        <NativeSelect
          name="deadlineReminder"
          defaultValue={
            task.deadlineReminder == null
              ? "none"
              : String(task.deadlineReminder.minutes)
          }
          disabled={remindersDisabled || !timedDeadline}
        >
          <option value="none">No reminder</option>
          {offsets.map((minutes) => (
            <option key={minutes} value={String(minutes)}>
              {offsetLabel(minutes)}
            </option>
          ))}
        </NativeSelect>
      </label>
      {!timedDeadline ? (
        <p className="hint">Deadline reminders need a deadline with a time.</p>
      ) : null}
      <Button disabled={disabled}>Save planning</Button>
    </form>
  );
};
