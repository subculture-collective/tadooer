import type { LocalStore } from "../../local-store.ts";
import type { TaskHierarchyActions } from "./TaskHierarchy.tsx";

/**
 * Hierarchy writes go through the offline outbox (ADR 0018). A new child is a
 * `task.create` followed by a `task.move`; if the move later conflicts, the
 * task stays visible at top level instead of disappearing.
 */
export const createTaskHierarchyActions = (
  store: Pick<LocalStore, "queueTaskCreate" | "queueTaskMove">,
  commit: (queue: () => Promise<void>) => Promise<void>,
): TaskHierarchyActions => ({
  onCreateChildTask: (parent, title) =>
    commit(async () => {
      const created = await store.queueTaskCreate({ title });
      if (created.kind !== "task.create")
        throw new Error("The child task could not be queued");
      await store.queueTaskMove(created.task.id, parent.id, null);
    }),
  onMoveTask: (task, parentId, index) =>
    commit(async () => {
      await store.queueTaskMove(task.id, parentId, index);
    }),
});
