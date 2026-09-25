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

/** Parse the planning form into a task patch; the server enforces exclusivity. */
export const taskPlanningPatchFromForm = (data: FormData): TaskPatchRequest => {
  const text = (name: string): string => {
    const value = data.get(name);
    return typeof value === "string" ? value : "";
  };
  const reminder = text("startReminder");
  const deadlineReminder = text("deadlineReminder");
  return taskPatchRequestSchema.parse({
    plannedDay: text("plannedDay") === "" ? null : text("plannedDay"),
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
  readonly onSubmit: (task: Task, patch: TaskPatchRequest) => Promise<void>;
}

export const TaskPlanningForm = ({
  task,
  timeZone,
  busy,
  available,
  onSubmit,
}: TaskPlanningFormProps) => {
  const disabled = busy || !available;
  const timedDeadline = task.deadline?.kind === "instant";
  return (
    <form
      className="task-edit task-planning"
      aria-label={`Planning and reminders for “${task.title}”`}
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(
          task,
          taskPlanningPatchFromForm(new FormData(event.currentTarget)),
        );
      }}
    >
      {!available ? (
        <p className="hint">
          Reconnect to change planning and reminders. The server sends
          reminders, so these edits are not queued offline.
        </p>
      ) : null}
      <label className="field">
        <span>Planned day ({timeZone})</span>
        <Input
          name="plannedDay"
          type="date"
          defaultValue={task.plannedDay ?? ""}
          disabled={disabled}
        />
      </label>
      {task.plannedStart != null ? (
        <p className="hint">
          Choosing a day replaces the exact start. Remove a calendar block
          first.
        </p>
      ) : null}
      <label className="field">
        <span>Start reminder</span>
        <NativeSelect
          name="startReminder"
          defaultValue={startReminderValue(task)}
          disabled={disabled}
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
          disabled={disabled || !timedDeadline}
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
