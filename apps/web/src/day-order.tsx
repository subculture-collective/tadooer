import { useState } from "react";
import type { SavedDayOrder, Task } from "@suite/contracts";
import { applyDayOrder, dayOrderMembers, moveInDayOrder } from "@suite/domain";
import { Button } from "./components/ui/button.tsx";

/**
 * Saved Today and planner-day order in the browser (ADR 0027, ADR 0050).
 * Saved day orders are read from the offline cache and reordered through the
 * sync outbox, so both work without a connection. A date's members are
 * derived from the cached tasks; the saved order only sorts them.
 */
export interface DayOrderActions {
  /** Saves the complete order of a date; queued when offline. */
  readonly reorder: (date: string, taskIds: readonly string[]) => Promise<void>;
  /**
   * Gives each task the date as its planned day, then saves `order`, which
   * names the date's other members followed by the planned tasks.
   */
  readonly plan: (
    date: string,
    tasks: readonly Task[],
    order: readonly string[],
  ) => Promise<void>;
}

export interface DayOrderedTask {
  readonly task: Task;
  /**
   * Every cached member can be moved: the server reconciles membership when
   * it applies a reorder (ADR 0050).
   */
  readonly movable: boolean;
}

/** A date's local members in saved order, then in the derived order. */
export const orderedDayTasks = (
  tasks: readonly Task[],
  date: string,
  order: Pick<SavedDayOrder, "taskIds"> | undefined,
): readonly DayOrderedTask[] => {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return applyDayOrder(
    dayOrderMembers(
      tasks.map((task) => ({
        id: task.id,
        status: task.status,
        plannedStart: task.plannedStart,
        plannedDay: task.plannedDay,
        deletedAt: task.deletedAt,
        archivedAt: task.archivedAt,
      })),
      date,
    ),
    order?.taskIds ?? [],
  ).flatMap((id) => {
    const task = byId.get(id);
    return task === undefined ? [] : [{ task, movable: true }];
  });
};

export const dayOrderFailureNotice =
  "The day order could not be saved on this device. Try again.";

/**
 * The cached orders by date, with moves and plan-for-a-day saved through
 * `actions`. Without `actions` (no registered sync client) the derived
 * order is shown and the controls are disabled.
 */
export const useDayOrders = (input: {
  readonly tasks: readonly Task[];
  readonly saved: readonly SavedDayOrder[] | undefined;
  readonly actions: DayOrderActions | undefined;
}) => {
  const { tasks, actions } = input;
  const orders: ReadonlyMap<string, SavedDayOrder> = new Map(
    (input.saved ?? []).map((order) => [order.date, order]),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const enabled = actions !== undefined;

  const current = (date: string): readonly string[] =>
    orderedDayTasks(tasks, date, orders.get(date)).map(({ task }) => task.id);

  const run = async (write: () => Promise<void>): Promise<boolean> => {
    setPending(true);
    setMessage(null);
    try {
      await write();
      return true;
    } catch {
      setMessage(dayOrderFailureNotice);
      return false;
    } finally {
      setPending(false);
    }
  };

  const move = async (date: string, taskId: string, direction: -1 | 1) => {
    if (actions === undefined) return;
    const shown = current(date);
    const next = moveInDayOrder(shown, taskId, direction);
    if (next === shown) return;
    await run(() => actions.reorder(date, next));
  };

  const plan = async (
    date: string,
    planned: readonly Task[],
  ): Promise<boolean> => {
    if (actions === undefined || planned.length === 0) return false;
    const plannedIds = new Set(planned.map(({ id }) => id));
    return run(() =>
      actions.plan(date, planned, [
        ...current(date).filter((id) => !plannedIds.has(id)),
        ...planned.map(({ id }) => id),
      ]),
    );
  };

  return { orders, message, pending, enabled, move, plan };
};

export interface DayOrderListProps {
  readonly label: string;
  readonly items: readonly DayOrderedTask[];
  readonly available: boolean;
  readonly busy: boolean;
  readonly onMove: (taskId: string, direction: -1 | 1) => void;
}

/** An ordered task list with keyboard-accessible move controls. */
export const DayOrderList = ({
  label,
  items,
  available,
  busy,
  onMove,
}: DayOrderListProps) => {
  const movable = items.filter(({ movable }) => movable);
  return (
    <ol className="day-order-list" aria-label={label}>
      {items.map(({ task, movable: canMove }) => {
        const index = movable.findIndex(
          ({ task: item }) => item.id === task.id,
        );
        return (
          <li key={task.id} className="day-order-row">
            <span>{task.title}</span>
            <span className="day-order-actions">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Move “${task.title}” up`}
                disabled={!available || busy || !canMove || index <= 0}
                onClick={() => onMove(task.id, -1)}
              >
                Up
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Move “${task.title}” down`}
                disabled={
                  !available || busy || !canMove || index === movable.length - 1
                }
                onClick={() => onMove(task.id, 1)}
              >
                Down
              </Button>
            </span>
          </li>
        );
      })}
    </ol>
  );
};
