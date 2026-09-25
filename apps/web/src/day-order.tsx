import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, type DayOrder, type Task } from "@suite/contracts";
import { applyDayOrder, dayOrderMembers, moveInDayOrder } from "@suite/domain";
import { getDayOrders, planTasksForDay, reorderDayOrder } from "./api.ts";
import { Button } from "./components/ui/button.tsx";

/**
 * Saved Today and planner-day order in the browser (ADR 0027). Day orders
 * are read and written online only; offline the derived order is shown and
 * the move controls are disabled.
 */
export interface DayOrderApi {
  readonly getDayOrders: typeof getDayOrders;
  readonly reorderDayOrder: typeof reorderDayOrder;
  readonly planTasksForDay: typeof planTasksForDay;
}

export const defaultDayOrderApi: DayOrderApi = {
  getDayOrders,
  reorderDayOrder,
  planTasksForDay,
};

export interface DayOrderedTask {
  readonly task: Task;
  /** False when the server has not listed the task yet (offline edit). */
  readonly movable: boolean;
}

/** A date's local members in saved order, then in the derived order. */
export const orderedDayTasks = (
  tasks: readonly Task[],
  date: string,
  order: DayOrder | undefined,
): readonly DayOrderedTask[] => {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const saved = new Set(order?.taskIds ?? []);
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
    return task === undefined ? [] : [{ task, movable: saved.has(id) }];
  });
};

export const dayOrderConflictNotice =
  "The day's tasks or order changed; the current order is shown. Try again.";

const failureMessage = (error: unknown): string =>
  error instanceof ApiRequestError
    ? error.status === 412
      ? dayOrderConflictNotice
      : error.message
    : "The day order could not be saved. Check the connection and try again.";

/** Loads the orders of [from, to] and saves moves with full-list reorders. */
export const useDayOrders = (input: {
  readonly from: string;
  readonly to: string;
  readonly csrfToken: string | undefined;
  readonly online: boolean;
  readonly api?: DayOrderApi | undefined;
  /**
   * Changes when the local members of the range change (a task planned,
   * completed or moved), so the saved orders are read again.
   */
  readonly membersKey?: string | undefined;
}) => {
  const api = input.api ?? defaultDayOrderApi;
  const { from, to, csrfToken, online } = input;
  const [orders, setOrders] = useState<ReadonlyMap<string, DayOrder>>(
    new Map(),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const enabled = online && csrfToken !== undefined;

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const loaded = await api.getDayOrders(from, to);
      setOrders(new Map(loaded.map((order) => [order.date, order])));
    } catch (error: unknown) {
      setMessage(failureMessage(error));
    }
  }, [api, enabled, from, to]);

  const { membersKey } = input;
  useEffect(() => {
    void refresh();
  }, [refresh, membersKey]);

  const move = async (date: string, taskId: string, direction: -1 | 1) => {
    if (!enabled) return;
    const current = orders.get(date) ?? { date, revision: 0, taskIds: [] };
    const next = moveInDayOrder(current.taskIds, taskId, direction);
    if (next === current.taskIds) return;
    setPending(true);
    setMessage(null);
    try {
      const saved = await api.reorderDayOrder(
        date,
        current.revision,
        next,
        csrfToken,
      );
      setOrders((existing) => new Map(existing).set(date, saved));
    } catch (error: unknown) {
      setMessage(failureMessage(error));
      await refresh();
    } finally {
      setPending(false);
    }
  };

  const plan = async (
    date: string,
    tasks: readonly Task[],
  ): Promise<boolean> => {
    if (!enabled || tasks.length === 0) return false;
    setPending(true);
    setMessage(null);
    try {
      const result = await api.planTasksForDay(
        date,
        {
          expectedRevision: orders.get(date)?.revision ?? 0,
          tasks: tasks.map((task) => ({
            taskId: task.id,
            expectedRevision: task.revision,
          })),
        },
        csrfToken,
      );
      setOrders((existing) => new Map(existing).set(date, result.dayOrder));
      return true;
    } catch (error: unknown) {
      setMessage(failureMessage(error));
      await refresh();
      return false;
    } finally {
      setPending(false);
    }
  };

  return { orders, message, pending, enabled, move, plan, refresh };
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

/** A key that changes when any date's local members change. */
export const dayMembersKey = (
  tasks: readonly Task[],
  dates: readonly string[],
): string =>
  dates
    .map(
      (date) =>
        `${date}:${orderedDayTasks(tasks, date, undefined)
          .map(({ task }) => task.id)
          .join(",")}`,
    )
    .join(";");
