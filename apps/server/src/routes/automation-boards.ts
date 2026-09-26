import { randomUUID } from "node:crypto";
import type {
  AutomationConfirmationResponse,
  AutomationPreviewCommand,
  BoardMoveChange,
} from "@suite/contracts";
import type { BoardClock } from "@suite/domain";
import type { SuiteDatabase } from "@suite/persistence";
import { boardConflictMessage } from "./boards.ts";
import {
  menuFolderConflictMessage,
  sectionConflictMessage,
} from "./board-views.ts";

// Assistant operations for boards, sections, saved views and sidebar folders
// (issue #63, ADR 0028). automation.ts keeps the shared preview/confirm
// protocol; this module supplies the domain checks. Board, section and folder
// revisions are frozen in the preview; a task view has no entity ID, so its
// revision is checked again at confirmation.

export type BoardCommand = Extract<
  AutomationPreviewCommand,
  {
    operation:
      | "boards.mutate"
      | "sections.mutate"
      | "task_views.set"
      | "menu_folders.mutate";
  }
>;

interface Affected {
  readonly entityKind:
    "board" | "section" | "menu_folder" | "task" | "task_view";
  readonly entityId: string;
}
interface BaseRevision {
  readonly entityKind: "board" | "section" | "menu_folder" | "task";
  readonly entityId: string;
  readonly revision: number;
}
export type BoardPreview =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly affected: readonly Affected[];
      readonly baseRevisions: readonly BaseRevision[];
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };
type Result = AutomationConfirmationResponse["result"];
export type BoardConfirmation =
  | { readonly ok: true; readonly apply: () => Result }
  | { readonly ok: false; readonly status: number; readonly message: string };

export const isBoardCommand = (
  command: AutomationPreviewCommand,
): command is BoardCommand =>
  command.operation === "boards.mutate" ||
  command.operation === "sections.mutate" ||
  command.operation === "task_views.set" ||
  command.operation === "menu_folders.mutate";

const conflict = (message: string): BoardPreview => ({
  ok: false,
  status: 412,
  code: "REVISION_CONFLICT",
  message,
});
const invalid = (message: string, status = 400): BoardPreview => ({
  ok: false,
  status,
  code: status === 404 ? "NOT_FOUND" : "INVALID_INPUT",
  message,
});

const quoted = (value: string): string =>
  `"${value.length > 40 ? `${value.slice(0, 37)}...` : value}"`;

/** Human-readable change list for a panel move. */
export const describeMoveChanges = (
  database: SuiteDatabase,
  ownerId: string,
  changes: readonly BoardMoveChange[],
): string => {
  const tagName = (tagId: string) =>
    quoted(
      database.listTags(ownerId).find(({ id }) => id === tagId)?.title ??
        "an unavailable tag",
    );
  const projectName = (projectId: string) =>
    quoted(
      database.listProjects(ownerId).find(({ id }) => id === projectId)
        ?.title ?? "an unavailable project",
    );
  if (changes.length === 0) return "no task changes";
  return changes
    .map((change) => {
      switch (change.kind) {
        case "add_tag":
          return `add tag ${tagName(change.tagId)}`;
        case "remove_tag":
          return `remove tag ${tagName(change.tagId)}`;
        case "add_marker":
          return `mark ${change.marker.replace("_", " ")}`;
        case "remove_marker":
          return `unmark ${change.marker.replace("_", " ")}`;
        case "complete":
          return "complete the task";
        case "reopen":
          return "reopen the task";
        case "assign_project":
          return `move to project ${projectName(change.projectId)}`;
        case "plan_today":
          return `plan for ${change.date}`;
        case "clear_planned_day":
          return "clear the planned day";
        case "add_to_backlog":
          return "add to the project backlog";
        case "remove_from_backlog":
          return "remove from the project backlog";
      }
    })
    .join(", ");
};

export const previewBoardCommand = (
  database: SuiteDatabase,
  ownerId: string,
  command: BoardCommand,
  clock: BoardClock,
): BoardPreview => {
  const store = database.boards;
  if (command.operation === "boards.mutate") {
    const input = command.input;
    if (input.action === "create") {
      const title =
        "template" in input.board
          ? `the default ${input.board.template} board`
          : `board ${quoted(input.board.title)} with ${String(input.board.panels.length)} ${input.board.panels.length === 1 ? "panel" : "panels"}`;
      return {
        ok: true,
        summary: `Create ${title}`,
        affected: [],
        baseRevisions: [],
      };
    }
    const board = store.getBoard(ownerId, input.boardId);
    if (board === undefined) return invalid("Board not found", 404);
    const expected =
      input.action === "update"
        ? input.board.expectedRevision
        : input.action === "delete"
          ? input.expectedRevision
          : input.action === "reorder_panel"
            ? input.order.expectedRevision
            : input.move.expectedRevision;
    if (board.revision !== expected) return conflict(boardConflictMessage);
    const base: BaseRevision[] = [
      { entityKind: "board", entityId: board.id, revision: board.revision },
    ];
    const affected: Affected[] = [{ entityKind: "board", entityId: board.id }];
    switch (input.action) {
      case "update":
        return {
          ok: true,
          summary: `Replace the configuration of board ${quoted(board.title)}: title ${quoted(input.board.title)}, ${String(input.board.columns)} columns, ${String(input.board.panels.length)} panels`,
          affected,
          baseRevisions: base,
        };
      case "delete":
        return {
          ok: true,
          summary: `Delete board ${quoted(board.title)}; tasks are not changed`,
          affected,
          baseRevisions: base,
        };
      case "reorder_panel": {
        const panel = board.panels.find(({ id }) => id === input.panelId);
        if (panel === undefined) return invalid("Panel not found", 404);
        const members =
          store
            .viewBoard(ownerId, board.id, clock)
            ?.members.find(({ panelId }) => panelId === panel.id)?.taskIds ??
          [];
        const present = new Set(members);
        if (
          input.order.taskIds.length !== present.size ||
          !input.order.taskIds.every((id) => present.has(id))
        )
          return conflict(
            "The panel's tasks changed; reload the board and order every task it shows",
          );
        return {
          ok: true,
          summary: `Order the ${String(members.length)} tasks of panel ${quoted(panel.title)} on board ${quoted(board.title)}`,
          affected,
          baseRevisions: base,
        };
      }
      case "move_task": {
        const panel = board.panels.find(({ id }) => id === input.panelId);
        if (panel === undefined) return invalid("Panel not found", 404);
        const task = database.getTask(ownerId, input.move.taskId);
        if (task === undefined) return invalid("Task not found", 404);
        if (task.revision !== input.move.taskRevision)
          return conflict("The task changed; reload it before moving it");
        const plan = store.planMove(
          ownerId,
          board.id,
          panel.id,
          task.id,
          clock,
        );
        if (plan.kind !== "planned")
          return invalid(
            plan.kind === "invalid" ? plan.detail : "Panel not found",
            409,
          );
        return {
          ok: true,
          summary: `Move task ${quoted(task.title)} into panel ${quoted(panel.title)} of board ${quoted(board.title)}: ${describeMoveChanges(database, ownerId, plan.changes)}`,
          affected: [...affected, { entityKind: "task", entityId: task.id }],
          baseRevisions: [
            ...base,
            { entityKind: "task", entityId: task.id, revision: task.revision },
          ],
        };
      }
    }
  }
  if (command.operation === "sections.mutate") {
    const input = command.input;
    if (input.action === "create")
      return {
        ok: true,
        summary: `Create section ${quoted(input.section.title)} in ${input.section.contextKind} ${input.section.contextId}`,
        affected: [],
        baseRevisions: [],
      };
    if (input.action === "reorder") {
      const current = store.listSections(ownerId, input.order);
      if (
        current.length !== input.order.items.length ||
        !input.order.items.every((item) =>
          current.some((s) => s.id === item.id && s.revision === item.revision),
        )
      )
        return conflict(sectionConflictMessage);
      return {
        ok: true,
        summary: `Order the ${String(current.length)} sections of ${input.order.contextKind} ${input.order.contextId}`,
        affected: current.map(({ id }) => ({
          entityKind: "section",
          entityId: id,
        })),
        baseRevisions: current.map(({ id, revision }) => ({
          entityKind: "section",
          entityId: id,
          revision,
        })),
      };
    }
    const section = store.getSection(ownerId, input.sectionId);
    if (section === undefined) return invalid("Section not found", 404);
    const expected =
      input.action === "update"
        ? input.section.expectedRevision
        : input.expectedRevision;
    if (section.revision !== expected) return conflict(sectionConflictMessage);
    return {
      ok: true,
      summary:
        input.action === "delete"
          ? `Delete section ${quoted(section.title)}; its tasks stay in the list`
          : `Change section ${quoted(section.title)}: ${[
              input.section.title === undefined
                ? []
                : [`title ${quoted(input.section.title)}`],
              input.section.expanded === undefined
                ? []
                : [input.section.expanded ? "expand" : "collapse"],
              input.section.taskIds === undefined
                ? []
                : [`${String(input.section.taskIds.length)} tasks`],
            ]
              .flat()
              .join(", ")}`,
      affected: [{ entityKind: "section", entityId: section.id }],
      baseRevisions: [
        {
          entityKind: "section",
          entityId: section.id,
          revision: section.revision,
        },
      ],
    };
  }
  if (command.operation === "task_views.set") {
    const input = command.input;
    const current = store.getTaskView(
      ownerId,
      input.contextKind,
      input.contextId,
    );
    if (current.revision !== input.expectedRevision)
      return conflict("The saved view changed; read it again before saving");
    return {
      ok: true,
      summary: `Save the ${input.contextKind}${input.contextId === "" ? "" : ` ${input.contextId}`} view: sort ${input.sortBy ?? "default"} ${input.sortDir}, group ${input.groupBy ?? "none"}, filter ${input.filter?.kind ?? "none"}`,
      affected: [],
      baseRevisions: [],
    };
  }
  const input = command.input;
  if (input.action === "create")
    return {
      ok: true,
      summary: `Create ${input.folder.kind} folder ${quoted(input.folder.title)} with ${String(input.folder.itemIds.length)} items`,
      affected: [],
      baseRevisions: [],
    };
  if (input.action === "reorder") {
    const current = store
      .listMenuFolders(ownerId, input.order.kind)
      .filter((folder) => folder.parentId === input.order.parentId);
    if (
      current.length !== input.order.items.length ||
      !input.order.items.every((item) =>
        current.some((f) => f.id === item.id && f.revision === item.revision),
      )
    )
      return conflict(menuFolderConflictMessage);
    return {
      ok: true,
      summary: `Order the ${String(current.length)} ${input.order.kind} folders`,
      affected: current.map(({ id }) => ({
        entityKind: "menu_folder",
        entityId: id,
      })),
      baseRevisions: current.map(({ id, revision }) => ({
        entityKind: "menu_folder",
        entityId: id,
        revision,
      })),
    };
  }
  const folder = store.getMenuFolder(ownerId, input.folderId);
  if (folder === undefined) return invalid("Folder not found", 404);
  const expected =
    input.action === "update"
      ? input.folder.expectedRevision
      : input.expectedRevision;
  if (folder.revision !== expected) return conflict(menuFolderConflictMessage);
  return {
    ok: true,
    summary:
      input.action === "delete"
        ? `Delete folder ${quoted(folder.title)}; its items return to the top level`
        : `Change folder ${quoted(folder.title)}: ${[
            input.folder.title === undefined
              ? []
              : [`title ${quoted(input.folder.title)}`],
            input.folder.expanded === undefined
              ? []
              : [input.folder.expanded ? "expand" : "collapse"],
            input.folder.itemIds === undefined
              ? []
              : [`${String(input.folder.itemIds.length)} items`],
          ]
            .flat()
            .join(", ")}`,
    affected: [{ entityKind: "menu_folder", entityId: folder.id }],
    baseRevisions: [
      {
        entityKind: "menu_folder",
        entityId: folder.id,
        revision: folder.revision,
      },
    ],
  };
};

export const confirmBoardCommand = (
  database: SuiteDatabase,
  ownerId: string,
  command: BoardCommand,
  clock: BoardClock,
  now: () => string,
): BoardConfirmation => {
  const preview = previewBoardCommand(database, ownerId, command, clock);
  if (!preview.ok)
    return { ok: false, status: preview.status, message: preview.message };
  const store = database.boards;
  const changed = new Error("Board state changed during atomic confirmation");
  return {
    ok: true,
    apply: () => {
      if (command.operation === "boards.mutate") {
        const input = command.input;
        const boards = () => ({ boards: [...store.listBoards(ownerId)] });
        switch (input.action) {
          case "create": {
            const result = store.createBoard(
              ownerId,
              input.board,
              randomUUID,
              now(),
            );
            if (result.kind !== "applied") throw changed;
            return boards();
          }
          case "update": {
            const result = store.updateBoard(
              ownerId,
              input.boardId,
              input.board.expectedRevision,
              input.board,
              randomUUID,
              now(),
            );
            if (result.kind !== "applied") throw changed;
            return boards();
          }
          case "delete":
            if (
              store.deleteBoard(
                ownerId,
                input.boardId,
                input.expectedRevision,
              ) !== "applied"
            )
              throw changed;
            return boards();
          case "reorder_panel": {
            const result = store.reorderPanel(
              ownerId,
              input.boardId,
              input.panelId,
              input.order.expectedRevision,
              input.order.taskIds,
              clock,
              now(),
            );
            if (result.kind !== "applied") throw changed;
            const view = store.viewBoard(ownerId, input.boardId, clock);
            return view === undefined ? boards() : { view };
          }
          case "move_task": {
            const result = store.moveTask(
              ownerId,
              input.boardId,
              input.panelId,
              input.move,
              clock,
              now(),
            );
            if (result.kind !== "applied") throw changed;
            const view = store.viewBoard(ownerId, input.boardId, clock);
            return {
              changes: [...result.changes],
              ...(view === undefined ? {} : { view }),
            };
          }
        }
      }
      if (command.operation === "sections.mutate") {
        const input = command.input;
        const result =
          input.action === "create"
            ? store.createSection(ownerId, input.section, randomUUID, now())
            : input.action === "update"
              ? store.updateSection(
                  ownerId,
                  input.sectionId,
                  input.section.expectedRevision,
                  input.section,
                  now(),
                )
              : input.action === "delete"
                ? store.deleteSection(
                    ownerId,
                    input.sectionId,
                    input.expectedRevision,
                  )
                : store.reorderSections(
                    ownerId,
                    input.order,
                    input.order.items,
                    now(),
                  );
        if (result.kind !== "applied") throw changed;
        return { sections: [...result.sections] };
      }
      if (command.operation === "task_views.set") {
        const result = store.setTaskView(ownerId, command.input, now());
        if (result.kind !== "applied") throw changed;
        return { view: result.view };
      }
      const input = command.input;
      const result =
        input.action === "create"
          ? store.createMenuFolder(ownerId, input.folder, randomUUID, now())
          : input.action === "update"
            ? store.updateMenuFolder(
                ownerId,
                input.folderId,
                input.folder.expectedRevision,
                input.folder,
                now(),
              )
            : input.action === "delete"
              ? store.deleteMenuFolder(
                  ownerId,
                  input.folderId,
                  input.expectedRevision,
                )
              : store.reorderMenuFolders(
                  ownerId,
                  input.order.kind,
                  input.order.parentId,
                  input.order.items,
                  now(),
                );
      if (result.kind !== "applied") throw changed;
      return { folders: [...result.folders] };
    },
  };
};
