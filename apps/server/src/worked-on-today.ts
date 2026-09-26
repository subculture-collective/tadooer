import { planningDate } from "@suite/domain";
import type { SuiteDatabase } from "@suite/persistence";

/**
 * ADR 0030 `autoAddWorkedOnToToday`: starting focus on an open task that is
 * not planned for today plans it for the owner's current planning date. A
 * timed task, a task with a calendar block and a task already planned for
 * today are left alone. Returns true when the task changed.
 */
export const planWorkedOnTaskForToday = (
  database: SuiteDatabase,
  ownerId: string,
  taskId: string,
  now: Date,
): boolean => {
  if (
    !database.applicationPreferences.get(ownerId).preferences
      .autoAddWorkedOnToToday
  )
    return false;
  const task = database.getTask(ownerId, taskId);
  if (task?.status !== "open" || task.plannedStart !== null) return false;
  const planning = database.getPlanningPreferences(ownerId);
  const today = planningDate(now, planning.timeZone, planning.dayStartsAt);
  if (task.plannedDay === today) return false;
  if (database.getTaskCalendarBlock(ownerId, taskId) !== undefined)
    return false;
  return (
    database.patchTask(
      ownerId,
      taskId,
      task.revision,
      { plannedDay: today },
      now.toISOString(),
    ).kind === "updated"
  );
};
