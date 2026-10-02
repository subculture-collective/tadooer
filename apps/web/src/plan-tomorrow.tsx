import { useState } from "react";
import {
  dayOrderMaxPlannedTasks,
  type SavedDayOrder,
  type Task,
} from "@suite/contracts";
import { Button } from "./components/ui/button.tsx";
import { Card, CardContent, CardHeader } from "./components/ui/card.tsx";
import { Checkbox } from "./components/ui/checkbox.tsx";
import { SectionHeading } from "./components/ui/section-heading.tsx";
import { DayOrderList, orderedDayTasks } from "./day-order.tsx";

/**
 * Tasks that can be planned for a date: open, active, without an exact start
 * (a calendar block keeps its time) and not already planned for that date.
 * Today's date-only work comes first, then unplanned and other dated work.
 */
export const planCandidates = (
  tasks: readonly Task[],
  date: string,
  today: string,
): readonly Task[] => {
  const rank = (task: Task): number =>
    task.plannedDay === today ? 0 : task.plannedDay == null ? 1 : 2;
  return tasks
    .filter(
      (task) =>
        task.status === "open" &&
        task.deletedAt == null &&
        task.archivedAt == null &&
        task.plannedStart == null &&
        task.plannedDay !== date,
    )
    .toSorted(
      (left, right) =>
        rank(left) - rank(right) || left.title.localeCompare(right.title),
    );
};

export interface PlanTomorrowPanelProps {
  readonly date: string;
  readonly today: string;
  readonly tasks: readonly Task[];
  readonly order: Pick<SavedDayOrder, "taskIds"> | undefined;
  readonly available: boolean;
  readonly busy: boolean;
  readonly onPlan: (tasks: readonly Task[]) => Promise<boolean>;
  readonly onMove: (taskId: string, direction: -1 | 1) => void;
}

/**
 * Plan tomorrow (ADR 0027): pick tasks, give them tomorrow as their planned
 * day in the order picked, and arrange tomorrow's list.
 */
export const PlanTomorrowPanel = ({
  date,
  today,
  tasks,
  order,
  available,
  busy,
  onPlan,
  onMove,
}: PlanTomorrowPanelProps) => {
  const [picked, setPicked] = useState<readonly string[]>([]);
  const planned = orderedDayTasks(tasks, date, order);
  const candidates = planCandidates(tasks, date, today);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const selection = picked.flatMap((id) => {
    const task = byId.get(id);
    return task === undefined ? [] : [task];
  });
  return (
    <Card className="plan-tomorrow" aria-labelledby="plan-tomorrow-title">
      <CardHeader>
        <SectionHeading
          id="plan-tomorrow-title"
          eyebrow={date}
          title="Plan tomorrow"
        />
      </CardHeader>
      <CardContent className="grid gap-3">
        {!available ? (
          <p className="hint">
            Tomorrow can be planned once this device has synced.
          </p>
        ) : null}
        {planned.length === 0 ? (
          <p className="hint">Nothing is planned for tomorrow yet.</p>
        ) : (
          <DayOrderList
            label={`Order for ${date}`}
            items={planned}
            available={available}
            busy={busy}
            onMove={onMove}
          />
        )}
        {candidates.length > 0 ? (
          <form
            className="grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void onPlan(selection).then((saved) => {
                if (saved) setPicked([]);
              });
            }}
          >
            <fieldset className="grid gap-1">
              <legend>Add to tomorrow, in the order you pick them</legend>
              {candidates.map((task) => (
                <label key={task.id} className="flex items-center gap-2">
                  <Checkbox
                    checked={picked.includes(task.id)}
                    disabled={
                      !available ||
                      busy ||
                      (!picked.includes(task.id) &&
                        picked.length >= dayOrderMaxPlannedTasks)
                    }
                    onCheckedChange={(checked) =>
                      setPicked((current) =>
                        checked === true
                          ? [...current.filter((id) => id !== task.id), task.id]
                          : current.filter((id) => id !== task.id),
                      )
                    }
                  />
                  {task.title}
                  {task.plannedDay != null ? (
                    <span className="hint">
                      {" "}
                      · planned for {task.plannedDay}
                    </span>
                  ) : null}
                </label>
              ))}
            </fieldset>
            <Button
              type="submit"
              disabled={!available || busy || selection.length === 0}
            >
              Plan{" "}
              {selection.length === 0 ? "" : `${String(selection.length)} `}
              for tomorrow
            </Button>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
};
