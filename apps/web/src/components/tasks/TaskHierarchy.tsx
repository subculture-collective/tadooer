import type { ReactNode, SyntheticEvent } from "react";
import type { Task } from "@suite/contracts";
import { summarizeChildren } from "@suite/domain";
import { Field } from "../../field.tsx";
import { Button } from "../ui/button.tsx";
import { NativeSelect } from "../ui/native-select.tsx";

/** Hierarchy UI for the Tasks page (ADR 0018): two levels, full child tasks. */
export interface TaskHierarchyActions {
  readonly onCreateChildTask: (parent: Task, title: string) => Promise<void>;
  readonly onMoveTask: (
    task: Task,
    parentId: string | null,
    index: number | null,
  ) => Promise<void>;
}

/**
 * Target index for one step up or down. The index counts siblings without the
 * moving task, matching the server's `task.move` semantics.
 */
export const siblingMoveIndex = (
  siblings: readonly Pick<Task, "id">[],
  taskId: string,
  direction: "up" | "down",
): number | null => {
  const current = siblings.findIndex(({ id }) => id === taskId);
  if (current === -1) return null;
  const next = direction === "up" ? current - 1 : current + 1;
  return next < 0 || next >= siblings.length ? null : next;
};

const formTitle = (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
  event.preventDefault();
  const value = new FormData(event.currentTarget).get("title");
  return typeof value === "string" ? value.trim() : "";
};

export const TaskChildrenSection = ({
  parent,
  items,
  allItems = items,
  busy,
  renderChild,
  onCreateChildTask,
}: {
  readonly parent: Task;
  /** Children matching the current filters, in order. */
  readonly items: readonly Task[];
  /** Every active child; the progress summary ignores filters. */
  readonly allItems?: readonly Task[];
  readonly busy: boolean;
  readonly renderChild: (child: Task) => ReactNode;
  readonly onCreateChildTask: TaskHierarchyActions["onCreateChildTask"];
}) => {
  const rollup = summarizeChildren(allItems);
  const headingId = `child-tasks-${parent.id}`;
  return (
    <section className="task-children" aria-labelledby={headingId}>
      <h3 id={headingId} className="task-children__heading">
        Child tasks
      </h3>
      {rollup.total > 0 && (
        <p className="task-children__summary">
          {rollup.completed} of {rollup.total} done
          {rollup.openEstimateMinutes > 0 &&
            ` · ${String(rollup.openEstimateMinutes)} min estimated for open children`}
        </p>
      )}
      {items.length > 0 && (
        <ol className="tasks task-children__list">{items.map(renderChild)}</ol>
      )}
      <form
        className="task-actions"
        aria-label={`Add a child task to ${parent.title}`}
        onSubmit={(event) => {
          const form = event.currentTarget;
          const title = formTitle(event);
          if (title === "") return;
          void onCreateChildTask(parent, title).then(() => {
            form.reset();
          });
        }}
      >
        <Field label="New child task" name="title" autoComplete="off" />
        <Button disabled={busy}>Add child task</Button>
      </form>
    </section>
  );
};

export const TaskPlacementControls = ({
  task,
  siblings,
  parents,
  parentTitle,
  hasChildren,
  busy,
  onMoveTask,
}: {
  readonly task: Task;
  /** Ordered children of the task's parent, including the task itself. */
  readonly siblings: readonly Task[];
  /** Live top-level tasks that could adopt this task. */
  readonly parents: readonly Task[];
  readonly parentTitle: string | null;
  readonly hasChildren: boolean;
  readonly busy: boolean;
  readonly onMoveTask: TaskHierarchyActions["onMoveTask"];
}) => {
  const candidates = parents.filter(
    ({ id }) => id !== task.id && id !== task.parentId,
  );
  const isChild = task.parentId != null;
  const step = (direction: "up" | "down") =>
    siblingMoveIndex(siblings, task.id, direction);
  return (
    <fieldset className="task-placement">
      <legend>Placement</legend>
      {isChild && (
        <p className="task-placement__parent">
          Child of {parentTitle === null ? "another task" : `"${parentTitle}"`}
        </p>
      )}
      <div className="task-actions">
        {isChild && (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={busy || step("up") === null}
              aria-label={`Move "${task.title}" up among child tasks`}
              onClick={() =>
                void onMoveTask(task, task.parentId ?? null, step("up"))
              }
            >
              Move up
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy || step("down") === null}
              aria-label={`Move "${task.title}" down among child tasks`}
              onClick={() =>
                void onMoveTask(task, task.parentId ?? null, step("down"))
              }
            >
              Move down
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void onMoveTask(task, null, null)}
            >
              Make top-level task
            </Button>
          </>
        )}
        {hasChildren ? (
          <p className="muted">
            A task with child tasks stays top-level. Move its children first.
          </p>
        ) : (
          candidates.length > 0 && (
            <form
              aria-label={`Move "${task.title}" under another task`}
              onSubmit={(event) => {
                event.preventDefault();
                const value = new FormData(event.currentTarget).get("parentId");
                if (typeof value === "string" && value !== "")
                  void onMoveTask(task, value, null);
              }}
            >
              <label className="field">
                <span>{isChild ? "Move to parent" : "Make child of"}</span>
                <NativeSelect name="parentId" defaultValue="" required>
                  <option value="" disabled>
                    Choose a task
                  </option>
                  {candidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.title}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              <Button disabled={busy}>Move</Button>
            </form>
          )
        )}
      </div>
    </fieldset>
  );
};
