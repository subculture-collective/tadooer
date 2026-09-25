import type {
  AutomationConfirmationResponse,
  AutomationPreviewCommand,
} from "@suite/contracts";
import { planningDate } from "@suite/domain";
import type { SuiteDatabase } from "@suite/persistence";
import { dayOrderConflictMessage, dayOrderResponse } from "./day-order.ts";

// Assistant read and reorder of a saved day order (issue #98, ADR 0027).
// automation.ts keeps the shared preview/confirm protocol. A day order has no
// entity ID, so nothing is frozen in baseRevisions: confirmation repeats the
// preview checks (revision and exact membership) inside its transaction.

export type DayOrderCommand = Extract<
  AutomationPreviewCommand,
  { operation: "day_order.reorder" }
>;

type Result = AutomationConfirmationResponse["result"];

export const isDayOrderCommand = (
  command: AutomationPreviewCommand,
): command is DayOrderCommand => command.operation === "day_order.reorder";

/** The requested date, or the owner's current planning date. */
export const dayOrderResourceDate = (
  database: SuiteDatabase,
  ownerId: string,
  date: string | undefined,
  now: Date,
): string => {
  if (date !== undefined) return date;
  const preferences = database.getPlanningPreferences(ownerId);
  return planningDate(now, preferences.timeZone, preferences.dayStartsAt);
};

const quoted = (value: string): string =>
  `"${value.length > 40 ? `${value.slice(0, 37)}...` : value}"`;

export type DayOrderPreview =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly affected: readonly {
        readonly entityKind: "task";
        readonly entityId: string;
      }[];
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };

export const previewDayOrder = (
  database: SuiteDatabase,
  ownerId: string,
  command: DayOrderCommand,
): DayOrderPreview => {
  const input = command.input;
  const current = database.dayOrders.get(ownerId, input.date);
  const members = new Set(current.taskIds);
  if (
    current.revision !== input.expectedRevision ||
    input.taskIds.length !== members.size ||
    !input.taskIds.every((id) => members.has(id))
  )
    return {
      ok: false,
      status: 412,
      code: "REVISION_CONFLICT",
      message: dayOrderConflictMessage,
    };
  const titles = input.taskIds.map((id) => {
    const task = database.getTask(ownerId, id);
    return task === undefined ? "an unavailable task" : quoted(task.title);
  });
  const shown = titles.slice(0, 10).join(", ");
  return {
    ok: true,
    summary: `Order the ${String(input.taskIds.length)} ${input.taskIds.length === 1 ? "task" : "tasks"} planned for ${input.date}: ${shown}${titles.length > 10 ? `, and ${String(titles.length - 10)} more` : ""}`,
    affected: input.taskIds.map((entityId) => ({
      entityKind: "task" as const,
      entityId,
    })),
  };
};

export const confirmDayOrder = (
  database: SuiteDatabase,
  ownerId: string,
  command: DayOrderCommand,
  now: () => string,
):
  | { readonly ok: true; readonly apply: () => Result }
  | {
      readonly ok: false;
      readonly status: number;
      readonly message: string;
    } => {
  const current = previewDayOrder(database, ownerId, command);
  if (!current.ok)
    return { ok: false, status: current.status, message: current.message };
  return {
    ok: true,
    apply: () => {
      const result = database.dayOrders.reorder({
        ownerId,
        date: command.input.date,
        expectedRevision: command.input.expectedRevision,
        taskIds: command.input.taskIds,
        now: now(),
      });
      if (result.kind !== "applied")
        throw new Error("Day order changed during atomic confirmation");
      return { dayOrder: dayOrderResponse(result.dayOrder) };
    },
  };
};
