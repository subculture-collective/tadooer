import type { TaskPatchRequest } from "@suite/contracts";
import type { SuiteDatabase, TaskPatch } from "@suite/persistence";

/** Date-only planning and per-task reminder rules shared by HTTP and automation (ADR 0020). */

export const deadlineReminderRequiresTimeMessage =
  "A deadline reminder requires a deadline with a time";

export const plannedDayBlockedMessage =
  "Remove the calendar block before planning this task for a day";

export const planningPatch = (
  patch: TaskPatchRequest,
): Pick<
  TaskPatch,
  "plannedDay" | "startReminder" | "deadlineReminderMinutes"
> => ({
  ...(patch.plannedDay === undefined ? {} : { plannedDay: patch.plannedDay }),
  ...(patch.startReminder === undefined
    ? {}
    : { startReminder: patch.startReminder }),
  ...(patch.deadlineReminder === undefined
    ? {}
    : { deadlineReminderMinutes: patch.deadlineReminder?.minutes ?? null }),
});

export interface PlanningPatchProblem {
  readonly status: 400 | 409;
  readonly code: "INVALID_TASK" | "TIME_BLOCK_REMOVE_REQUIRED";
  readonly message: string;
}

/**
 * Reject a planning edit that would contradict calendar authority or leave a
 * reminder without a time. Returns undefined when the task is missing so the
 * conditional update reports its ordinary not-found result.
 */
export const planningPatchProblem = (
  database: SuiteDatabase,
  ownerId: string,
  taskId: string,
  patch: TaskPatchRequest,
): PlanningPatchProblem | undefined => {
  const task = database.getTask(ownerId, taskId);
  if (task === undefined) return undefined;
  // An active Suite-created block makes the exact start calendar-authoritative.
  if (
    patch.plannedDay != null &&
    database.getTaskCalendarBlock(ownerId, taskId) !== undefined
  )
    return {
      status: 409,
      code: "TIME_BLOCK_REMOVE_REQUIRED",
      message: plannedDayBlockedMessage,
    };
  // Clearing a deadline or making it date-only removes its reminder in
  // persistence; only an explicit reminder without a timed deadline fails.
  const timedDeadline =
    patch.deadline === undefined
      ? (task.deadlineAt ?? null) !== null
      : patch.deadline?.kind === "instant";
  if (patch.deadlineReminder != null && !timedDeadline)
    return {
      status: 400,
      code: "INVALID_TASK",
      message: deadlineReminderRequiresTimeMessage,
    };
  return undefined;
};
