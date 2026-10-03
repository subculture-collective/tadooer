import { useState, type SyntheticEvent } from "react";
import {
  habitCommandSchema,
  type HabitCommand,
  type HabitListResponse,
} from "@suite/contracts";
import { deriveHabitMetrics, habitDateAt, habitDueOn } from "@suite/domain";
import { Alert, AlertDescription } from "../components/ui/alert.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardContent, CardHeader } from "../components/ui/card.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { Input } from "../components/ui/input.tsx";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { PageHeader } from "../components/ui/page-header.tsx";
import { SectionHeading } from "../components/ui/section-heading.tsx";

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
    <section
      className="mx-auto flex w-full max-w-5xl flex-col gap-6"
      aria-labelledby="habits-heading"
    >
      <PageHeader
        id="habits-heading"
        title="Habits"
        description="Things you repeat. Each habit keeps its history in its own time zone."
      />
      {!online && (
        <Alert variant="warning" role="status">
          <AlertDescription>
            Connect to record or change habits.
          </AlertDescription>
        </Alert>
      )}
      {pending && (
        <Alert variant="info" role="status">
          <AlertDescription>
            A habit change is waiting for sync. Use Sync now to retry it.
          </AlertDescription>
        </Alert>
      )}
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <SectionHeading title="Create a habit" />
        </CardHeader>
        <CardContent>
          <form onSubmit={(event) => void create(event)}>
            <fieldset disabled={disabled} className="habit-create">
              <legend>Create a habit</legend>
              <label className="field">
                Habit name
                <Input
                  name="title"
                  required
                  maxLength={240}
                  placeholder="Take a walk"
                />
              </label>
              <label className="field">
                Repeat
                <NativeSelect
                  value={cadence}
                  onChange={(event) => setCadence(event.target.value)}
                >
                  <option value="daily">Every day</option>
                  <option value="weekly">Selected weekdays</option>
                  <option value="custom">Every few days</option>
                </NativeSelect>
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
                        <Checkbox name="weekday" value={String(index)} />
                        {day}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
              {cadence === "custom" && (
                <label className="field">
                  Interval in days
                  <Input
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
                Starts today in {timeZone}. The schedule stays fixed after
                creation.
              </p>
              <Button type="submit">Create habit</Button>
            </fieldset>
          </form>
        </CardContent>
      </Card>
      {library.habits.length === 0 && (
        <EmptyState
          title="No habits yet."
          description="Add one thing you want to repeat."
        />
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
            <Card
              className="habit-card"
              key={habit.id}
              aria-label={habit.title}
            >
              <CardHeader>
                <SectionHeading
                  as="h3"
                  title={habit.title}
                  actions={
                    habit.archivedAt !== null ? (
                      <Badge variant="secondary">Archived</Badge>
                    ) : undefined
                  }
                />
              </CardHeader>
              <CardContent className="grid gap-3">
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
                </p>
                <p>
                  Current streak: {metrics.currentStreak} · Longest streak:{" "}
                  {metrics.longestStreak} · Completed:{" "}
                  {metrics.completedPeriods}
                </p>
                {habit.archivedAt === null && (
                  <>
                    <Button
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
                    </Button>
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
                      <label className="field">
                        Rename {habit.title}
                        <Input
                          name="title"
                          defaultValue={habit.title}
                          key={habit.revision}
                          required
                          maxLength={240}
                          disabled={disabled}
                        />
                      </label>
                      <Button disabled={disabled} type="submit">
                        Save name
                      </Button>
                    </form>
                  </>
                )}
                <Button
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
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
};
