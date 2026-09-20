import { useState, type SyntheticEvent } from "react";
import {
  habitCommandSchema,
  type HabitCommand,
  type HabitListResponse,
} from "@suite/contracts";
import { deriveHabitMetrics, habitDateAt, habitDueOn } from "@suite/domain";

const titleFrom = (data: FormData): string => {
  const value = data.get("title");
  return typeof value === "string" ? value : "";
};

export interface HabitsPageProps {
  readonly library: HabitListResponse;
  readonly timeZone: string;
  readonly online: boolean;
  readonly pending: boolean;
  readonly onCommand: (command: HabitCommand) => Promise<void>;
  readonly now?: string;
}

export const HabitsPage = ({
  library,
  timeZone,
  online,
  pending,
  onCommand,
  now = new Date().toISOString(),
}: HabitsPageProps) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cadence, setCadence] = useState("daily");
  const disabled = busy || pending || !online;
  const execute = async (command: HabitCommand): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await onCommand(habitCommandSchema.parse(command));
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Habit could not be saved",
      );
      return false;
    } finally {
      setBusy(false);
    }
  };
  const create = async (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
  ) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const saved = await execute({
      kind: "habit.create",
      habit: {
        id: crypto.randomUUID(),
        title: titleFrom(data),
        timeZone,
        startedOn: habitDateAt(now, timeZone),
        cadence:
          cadence === "weekly"
            ? { kind: "weekly", weekdays: data.getAll("weekday").map(Number) }
            : cadence === "custom"
              ? {
                  kind: "custom",
                  intervalDays: Number(data.get("intervalDays")),
                }
              : { kind: "daily" },
      },
    });
    if (saved) form.reset();
  };
  return (
    <section className="panel" aria-labelledby="habits-heading">
      <h1 id="habits-heading">Habits</h1>
      <p>
        Small actions, repeated. Completion history uses each habit’s timezone.
      </p>
      {!online && <p role="status">Connect to record or change habits.</p>}
      {pending && (
        <p role="status">
          A habit change is waiting for sync. Use Sync now to retry it.
        </p>
      )}
      {error !== null && <p role="alert">{error}</p>}
      <form onSubmit={(event) => void create(event)}>
        <fieldset disabled={disabled} className="habit-create">
          <legend>Create a habit</legend>
          <label>
            Habit name
            <input
              name="title"
              required
              maxLength={240}
              placeholder="Take a walk"
            />
          </label>
          <label>
            Repeat
            <select
              value={cadence}
              onChange={(event) => setCadence(event.target.value)}
            >
              <option value="daily">Every day</option>
              <option value="weekly">Selected weekdays</option>
              <option value="custom">Every few days</option>
            </select>
          </label>
          {cadence === "weekly" && (
            <fieldset>
              <legend>Weekdays</legend>
              <div className="habit-weekdays">
                {[
                  "Monday",
                  "Tuesday",
                  "Wednesday",
                  "Thursday",
                  "Friday",
                  "Saturday",
                  "Sunday",
                ].map((day, index) => (
                  <label key={day}>
                    <input type="checkbox" name="weekday" value={index} />
                    {day}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {cadence === "custom" && (
            <label>
              Interval in days
              <input
                name="intervalDays"
                type="number"
                min={1}
                max={365}
                defaultValue={2}
                required
              />
            </label>
          )}
          <p>
            Starts today in {timeZone}. The schedule stays fixed after creation.
          </p>
          <button type="submit">Create habit</button>
        </fieldset>
      </form>
      {library.habits.length === 0 && (
        <p>No habits yet. Start with one action you want to repeat.</p>
      )}
      <div className="habit-list">
        {library.habits.map((habit) => {
          const today = habitDateAt(now, habit.timeZone);
          const occurrences = library.occurrences.filter(
            ({ habitId }) => habitId === habit.id,
          );
          const completed = occurrences.some(
            ({ periodKey }) => periodKey === today,
          );
          const due = habitDueOn(habit, today);
          const metrics = deriveHabitMetrics(habit, occurrences, today);
          return (
            <article
              className="habit-card"
              key={habit.id}
              aria-label={habit.title}
            >
              <h2>{habit.title}</h2>
              <p>
                {habit.cadence.kind === "daily"
                  ? "Every day"
                  : habit.cadence.kind === "custom"
                    ? `Every ${String(habit.cadence.intervalDays)} days`
                    : habit.cadence.weekdays
                        .map(
                          (day) =>
                            ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][
                              day
                            ],
                        )
                        .join(", ")}{" "}
                · {habit.timeZone}
                {habit.archivedAt !== null ? " · Archived" : ""}
              </p>
              <p>
                Current streak: {metrics.currentStreak} · Longest streak:{" "}
                {metrics.longestStreak} · Completed: {metrics.completedPeriods}
              </p>
              {habit.archivedAt === null && (
                <>
                  <button
                    type="button"
                    disabled={disabled || completed || !due}
                    onClick={() =>
                      void execute({
                        kind: "habit.complete",
                        habitId: habit.id,
                        baseRevision: habit.revision,
                        periodKey: today,
                      })
                    }
                  >
                    {completed
                      ? "Completed today"
                      : due
                        ? "Complete today"
                        : "Not scheduled today"}
                  </button>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const data = new FormData(event.currentTarget);
                      void execute({
                        kind: "habit.patch",
                        habitId: habit.id,
                        baseRevision: habit.revision,
                        fields: { title: titleFrom(data) },
                      });
                    }}
                  >
                    <label>
                      Rename {habit.title}
                      <input
                        name="title"
                        defaultValue={habit.title}
                        key={habit.revision}
                        required
                        maxLength={240}
                        disabled={disabled}
                      />
                    </label>
                    <button disabled={disabled} type="submit">
                      Save name
                    </button>
                  </form>
                </>
              )}
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  void execute({
                    kind:
                      habit.archivedAt === null
                        ? "habit.archive"
                        : "habit.restore",
                    habitId: habit.id,
                    baseRevision: habit.revision,
                  })
                }
              >
                {habit.archivedAt === null ? "Archive" : "Restore"}{" "}
                {habit.title}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
};
