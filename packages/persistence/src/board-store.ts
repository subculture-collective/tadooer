import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { storedBoardMarkers } from "@suite/contracts";
import {
  boardPanelFilterSchema,
  boardTemplateSchema,
  menuFolderMaxDepth,
  type Board,
  type BoardMarker,
  type BoardMoveChange,
  type BoardPanelFilter,
  type BoardPanelFilterInput,
  type BoardView,
  type MenuFolder,
  type MenuFolderKind,
  type Section,
  type SectionContextKind,
  type TaskView,
  type TaskViewContextKind,
  type TaskViewSetRequest,
} from "@suite/contracts";
import {
  boardTemplate,
  planPanelMove,
  sortPanelTasks,
  taskMatchesPanel,
  type BoardClock,
  type BoardPanelFilter as DomainBoardPanelFilter,
  type BoardTaskFacts,
} from "@suite/domain";

/**
 * Boards, sections, saved task views and sidebar folders (issue #63, ADR
 * 0028). All are owner-scoped online HTTP records with revisions, outside
 * the sync change feed and the offline cache.
 *
 * - A board owns ordered panels; a panel is a saved filter plus an optional
 *   manual task order. Membership is computed on read; manual ranks of tasks
 *   that stopped matching are ignored and pruned by the next order write.
 * - Board markers (urgent, important, in_progress) are stored per task
 *   beside its tags and never become tags; `today` is derived (ADR 0027).
 * - A section names an ordered subset of a project's or tag's active tasks.
 *   Membership is stored; tasks that left the context are ignored on read
 *   and pruned by the next write. A task sits in one section per context.
 * - A task view stores sort, group, filter and collapsed groups per context.
 * - A menu folder groups projects or tags in the sidebar; an item is in at
 *   most one folder.
 */
export const boardsMigration = {
  id: "0032_boards_sections_views",
  sql: `
      CREATE TABLE boards (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
        columns INTEGER NOT NULL CHECK (columns BETWEEN 1 AND 6),
        position INTEGER NOT NULL CHECK (position >= 0),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX boards_by_owner ON boards(owner_id, position, id);
      CREATE TABLE board_panels (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
        position INTEGER NOT NULL CHECK (position >= 0),
        filter_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX board_panels_by_board ON board_panels(board_id, position, id);
      CREATE TABLE board_panel_tasks (
        panel_id TEXT NOT NULL REFERENCES board_panels(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 0),
        PRIMARY KEY (panel_id, task_id)
      ) STRICT;
      CREATE TABLE task_board_markers (
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        marker TEXT NOT NULL CHECK (marker IN ('urgent', 'important', 'in_progress')),
        PRIMARY KEY (task_id, marker)
      ) STRICT;
      CREATE TRIGGER task_board_markers_owner
      BEFORE INSERT ON task_board_markers
      WHEN NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = NEW.task_id
        AND t.owner_id = NEW.owner_id)
      BEGIN
        SELECT RAISE(ABORT, 'board marker task belongs to another owner');
      END;
      CREATE TABLE sections (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        context_kind TEXT NOT NULL CHECK (context_kind IN ('project', 'tag')),
        context_id TEXT NOT NULL,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        expanded INTEGER NOT NULL CHECK (expanded IN (0, 1)),
        position INTEGER NOT NULL CHECK (position >= 0),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX sections_by_context
        ON sections(owner_id, context_kind, context_id, position, id);
      CREATE TABLE section_tasks (
        section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 0),
        PRIMARY KEY (section_id, task_id)
      ) STRICT;
      CREATE TABLE task_views (
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        context_kind TEXT NOT NULL
          CHECK (context_kind IN ('all', 'today', 'project', 'tag')),
        context_id TEXT NOT NULL,
        sort_by TEXT,
        sort_dir TEXT NOT NULL CHECK (sort_dir IN ('asc', 'desc')),
        group_by TEXT,
        filter_json TEXT NOT NULL,
        collapsed_json TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (owner_id, context_kind, context_id)
      ) STRICT;
      CREATE TABLE menu_folders (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('project', 'tag')),
        parent_id TEXT REFERENCES menu_folders(id) ON DELETE CASCADE,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
        expanded INTEGER NOT NULL CHECK (expanded IN (0, 1)),
        position INTEGER NOT NULL CHECK (position >= 0),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX menu_folders_by_owner
        ON menu_folders(owner_id, kind, parent_id, position, id);
      CREATE TABLE menu_folder_items (
        folder_id TEXT NOT NULL REFERENCES menu_folders(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position >= 0),
        PRIMARY KEY (item_id)
      ) STRICT;
    `,
};

type Row = Record<string, string | number | null>;
type StoredMarker = (typeof storedBoardMarkers)[number];

export interface BoardPanelInput {
  readonly id?: string | undefined;
  readonly title: string;
  readonly filter?: BoardPanelFilterInput | DomainBoardPanelFilter | undefined;
}
export interface BoardConfigInput {
  readonly title: string;
  readonly columns: number;
  readonly panels: readonly BoardPanelInput[];
}

export type BoardMutationResult =
  | { readonly kind: "applied"; readonly board: Board }
  | { readonly kind: "conflict" }
  | { readonly kind: "invalid"; readonly detail: string };

export type BoardMoveResult =
  | { readonly kind: "applied"; readonly changes: readonly BoardMoveChange[] }
  | { readonly kind: "conflict" }
  | { readonly kind: "task-conflict" }
  | { readonly kind: "invalid"; readonly detail: string };

export type SectionMutationResult =
  | { readonly kind: "applied"; readonly sections: readonly Section[] }
  | { readonly kind: "conflict" }
  | { readonly kind: "invalid"; readonly detail: string };

export type MenuFolderMutationResult =
  | { readonly kind: "applied"; readonly folders: readonly MenuFolder[] }
  | { readonly kind: "conflict" }
  | { readonly kind: "invalid"; readonly detail: string };

export type TaskViewSetResult =
  | { readonly kind: "applied"; readonly view: TaskView }
  | { readonly kind: "conflict" }
  | { readonly kind: "invalid"; readonly detail: string };

export interface BoardStoreDeps {
  readonly setTags: (
    ownerId: string,
    taskId: string,
    tagIds: readonly string[],
    expectedRevision: number,
    now: string,
  ) => boolean;
  readonly setCompleted: (
    ownerId: string,
    taskId: string,
    expectedRevision: number,
    completed: boolean,
    now: string,
  ) => boolean;
  readonly assignProject: (
    ownerId: string,
    taskId: string,
    projectId: string,
    expectedRevision: number,
    now: string,
  ) => boolean;
  readonly setPlannedDay: (
    ownerId: string,
    taskId: string,
    expectedRevision: number,
    plannedDay: string | null,
    now: string,
  ) => "applied" | "conflict" | "blocked";
  readonly setBacklog: (
    ownerId: string,
    projectId: string,
    taskId: string,
    inBacklog: boolean,
    now: string,
  ) => boolean;
  readonly currentTaskRevision: (
    ownerId: string,
    taskId: string,
  ) => number | undefined;
}

/** Import inputs; every ID is a source ID resolved through `resolve`. */
export interface ImportedBoard {
  readonly sourceId: string;
  readonly sourceJson: string;
  readonly title: string;
  readonly columns: number;
  readonly panels: readonly {
    readonly sourceId: string;
    readonly title: string;
    readonly filter: BoardPanelFilter;
    readonly sourceTaskIds: readonly string[];
  }[];
}
export interface ImportedSection {
  readonly sourceId: string;
  readonly sourceJson: string;
  readonly contextKind: SectionContextKind;
  readonly sourceContextId: string;
  readonly title: string;
  readonly expanded: boolean;
  readonly sourceTaskIds: readonly string[];
}
export interface ImportedMenuFolder {
  readonly sourceId: string;
  readonly sourceJson: string;
  readonly kind: MenuFolderKind;
  /** Source ID of the enclosing folder; parents precede children. */
  readonly sourceParentId: string | null;
  readonly title: string;
  readonly expanded: boolean;
  readonly sourceItemIds: readonly string[];
}
export interface ImportedBoardData {
  readonly boards: readonly ImportedBoard[];
  readonly sections: readonly ImportedSection[];
  readonly folders: readonly ImportedMenuFolder[];
  /** Source task ID to stored markers. */
  readonly taskMarkers: readonly {
    readonly sourceTaskId: string;
    readonly markers: readonly StoredMarker[];
  }[];
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

export class SqliteBoardStore {
  readonly #database: DatabaseSync;
  readonly #deps: BoardStoreDeps;

  constructor(database: DatabaseSync, deps: BoardStoreDeps) {
    this.#database = database;
    this.#deps = deps;
  }

  #inSavepoint<T>(name: string, run: () => T): T {
    this.#database.exec(`SAVEPOINT ${name};`);
    try {
      const result = run();
      this.#database.exec(`RELEASE SAVEPOINT ${name};`);
      return result;
    } catch (error) {
      this.#database.exec(
        `ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name};`,
      );
      throw error;
    }
  }

  #all(sql: string, ...params: (string | number | null)[]): readonly Row[] {
    return this.#database.prepare(sql).all(...params) as unknown as Row[];
  }
  #one(sql: string, ...params: (string | number | null)[]): Row | undefined {
    return this.#database.prepare(sql).get(...params) as unknown as
      Row | undefined;
  }
  #run(sql: string, ...params: (string | number | null)[]): number {
    return Number(this.#database.prepare(sql).run(...params).changes);
  }

  // ------------------------------------------------------------ task facts

  /** Active (not deleted or archived) tasks with tags, markers and backlog. */
  #taskFacts(ownerId: string): Map<string, BoardTaskFacts> {
    const facts = new Map<
      string,
      BoardTaskFacts & { tagIds: string[]; markers: StoredMarker[] }
    >();
    for (const row of this.#all(
      `SELECT t.id, t.title, t.status, t.project_id, t.planned_day, t.planned_start,
              t.deadline_date, t.deadline_at, t.created_at, t.estimate_minutes,
              t.parent_id, b.task_id AS backlog
       FROM tasks t LEFT JOIN project_backlog_tasks b ON b.task_id = t.id
       WHERE t.owner_id = ? AND t.deleted_at IS NULL AND t.archived_at IS NULL`,
      ownerId,
    ))
      facts.set(String(row.id), {
        id: String(row.id),
        title: String(row.title),
        status: row.status === "completed" ? "completed" : "open",
        projectId: row.project_id === null ? null : String(row.project_id),
        tagIds: [],
        markers: [],
        plannedDay: row.planned_day === null ? null : String(row.planned_day),
        plannedStart:
          row.planned_start === null ? null : String(row.planned_start),
        deadlineDate:
          row.deadline_date === null ? null : String(row.deadline_date),
        deadlineAt: row.deadline_at === null ? null : String(row.deadline_at),
        createdAt: String(row.created_at),
        estimateMinutes:
          row.estimate_minutes === null ? null : Number(row.estimate_minutes),
        parentId: row.parent_id === null ? null : String(row.parent_id),
        inBacklog: row.backlog !== null,
      });
    for (const row of this.#all(
      `SELECT tt.task_id, tt.tag_id FROM task_tags tt
       JOIN tasks t ON t.id = tt.task_id WHERE t.owner_id = ? ORDER BY tt.tag_id`,
      ownerId,
    ))
      facts.get(String(row.task_id))?.tagIds.push(String(row.tag_id));
    for (const row of this.#all(
      "SELECT task_id, marker FROM task_board_markers WHERE owner_id = ? ORDER BY marker",
      ownerId,
    ))
      facts.get(String(row.task_id))?.markers.push(row.marker as StoredMarker);
    return facts;
  }

  markersOf(ownerId: string, taskId: string): readonly StoredMarker[] {
    return this.#all(
      "SELECT marker FROM task_board_markers WHERE owner_id = ? AND task_id = ? ORDER BY marker",
      ownerId,
      taskId,
    ).map((row) => row.marker as StoredMarker);
  }

  #setMarkers(
    ownerId: string,
    taskId: string,
    markers: readonly StoredMarker[],
  ): void {
    this.#run(
      "DELETE FROM task_board_markers WHERE owner_id = ? AND task_id = ?",
      ownerId,
      taskId,
    );
    for (const marker of new Set(markers))
      this.#run(
        "INSERT INTO task_board_markers (owner_id, task_id, marker) VALUES (?, ?, ?)",
        ownerId,
        taskId,
        marker,
      );
  }

  // ----------------------------------------------------------------- boards

  #boardFromRow(row: Row, panels: readonly Board["panels"][number][]): Board {
    return {
      id: String(row.id),
      title: String(row.title),
      columns: Number(row.columns),
      position: Number(row.position),
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      panels: [...panels],
    };
  }

  #panels(boardIds: readonly string[]): Map<string, Board["panels"][number][]> {
    const byBoard = new Map<string, Board["panels"][number][]>();
    if (boardIds.length === 0) return byBoard;
    for (const row of this.#all(
      `SELECT id, board_id, title, filter_json FROM board_panels
       WHERE board_id IN (${boardIds.map(() => "?").join(",")})
       ORDER BY board_id, position, id`,
      ...boardIds,
    ))
      byBoard.set(String(row.board_id), [
        ...(byBoard.get(String(row.board_id)) ?? []),
        {
          id: String(row.id),
          title: String(row.title),
          filter: boardPanelFilterSchema.parse(
            JSON.parse(String(row.filter_json)),
          ),
        },
      ]);
    return byBoard;
  }

  listBoards(ownerId: string): readonly Board[] {
    const rows = this.#all(
      "SELECT * FROM boards WHERE owner_id = ? ORDER BY position, id",
      ownerId,
    );
    const panels = this.#panels(rows.map((row) => String(row.id)));
    return rows.map((row) =>
      this.#boardFromRow(row, panels.get(String(row.id)) ?? []),
    );
  }

  getBoard(ownerId: string, boardId: string): Board | undefined {
    const row = this.#one(
      "SELECT * FROM boards WHERE owner_id = ? AND id = ?",
      ownerId,
      boardId,
    );
    return row === undefined
      ? undefined
      : this.#boardFromRow(row, this.#panels([boardId]).get(boardId) ?? []);
  }

  /** Validates that every referenced tag and project belongs to the owner. */
  #validateFilter(
    ownerId: string,
    filter: BoardPanelFilter,
  ): string | undefined {
    for (const tagId of [...filter.includedTagIds, ...filter.excludedTagIds])
      if (
        this.#one(
          "SELECT 1 FROM tags WHERE owner_id = ? AND id = ?",
          ownerId,
          tagId,
        ) === undefined
      )
        return "A panel filter names a tag you do not own";
    for (const projectId of filter.projectIds)
      if (
        this.#one(
          "SELECT 1 FROM projects WHERE owner_id = ? AND id = ?",
          ownerId,
          projectId,
        ) === undefined
      )
        return "A panel filter names a project you do not own";
    return undefined;
  }

  #parsePanels(
    ownerId: string,
    panels: readonly BoardPanelInput[],
  ):
    | {
        ok: true;
        panels: readonly {
          id: string | undefined;
          title: string;
          filter: BoardPanelFilter;
        }[];
      }
    | { ok: false; detail: string } {
    const parsed: {
      id: string | undefined;
      title: string;
      filter: BoardPanelFilter;
    }[] = [];
    for (const panel of panels) {
      const filter = boardPanelFilterSchema.safeParse(panel.filter ?? {});
      if (!filter.success)
        return { ok: false, detail: "A panel filter is invalid" };
      const problem = this.#validateFilter(ownerId, filter.data);
      if (problem !== undefined) return { ok: false, detail: problem };
      parsed.push({ id: panel.id, title: panel.title, filter: filter.data });
    }
    return { ok: true, panels: parsed };
  }

  #writePanels(
    ownerId: string,
    boardId: string,
    panels: readonly {
      id: string | undefined;
      title: string;
      filter: BoardPanelFilter;
    }[],
    newId: () => string,
  ): void {
    const keep = new Set(
      panels.flatMap((panel) => (panel.id === undefined ? [] : [panel.id])),
    );
    for (const row of this.#all(
      "SELECT id FROM board_panels WHERE board_id = ?",
      boardId,
    ))
      if (!keep.has(String(row.id)))
        this.#run("DELETE FROM board_panels WHERE id = ?", String(row.id));
    // Positions are unique per board; park existing rows first.
    this.#run(
      "UPDATE board_panels SET position = position + 1000 WHERE board_id = ?",
      boardId,
    );
    panels.forEach((panel, position) => {
      if (
        panel.id !== undefined &&
        this.#run(
          "UPDATE board_panels SET title = ?, position = ?, filter_json = ? WHERE id = ? AND board_id = ?",
          panel.title,
          position,
          JSON.stringify(panel.filter),
          panel.id,
          boardId,
        ) === 1
      )
        return;
      this.#run(
        "INSERT INTO board_panels (id, owner_id, board_id, title, position, filter_json) VALUES (?, ?, ?, ?, ?, ?)",
        panel.id ?? newId(),
        ownerId,
        boardId,
        panel.title,
        position,
        JSON.stringify(panel.filter),
      );
    });
  }

  createBoard(
    ownerId: string,
    input: BoardConfigInput | { readonly template: "eisenhower" | "kanban" },
    newId: () => string,
    now: string,
  ): BoardMutationResult {
    const config: BoardConfigInput =
      "template" in input
        ? boardTemplate(boardTemplateSchema.parse(input.template))
        : input;
    return this.#inSavepoint("board_create", () => {
      const panels = this.#parsePanels(ownerId, config.panels);
      if (!panels.ok) return { kind: "invalid", detail: panels.detail };
      const id = newId();
      const position = Number(
        this.#one(
          "SELECT count(*) AS count FROM boards WHERE owner_id = ?",
          ownerId,
        )?.count ?? 0,
      );
      this.#run(
        "INSERT INTO boards (id, owner_id, title, columns, position, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
        id,
        ownerId,
        config.title,
        config.columns,
        position,
        now,
        now,
      );
      this.#writePanels(
        ownerId,
        id,
        panels.panels.map((panel) => ({ ...panel, id: undefined })),
        newId,
      );
      const board = this.getBoard(ownerId, id);
      if (board === undefined) throw new Error("Created board missing");
      return { kind: "applied", board };
    });
  }

  updateBoard(
    ownerId: string,
    boardId: string,
    expectedRevision: number,
    input: BoardConfigInput,
    newId: () => string,
    now: string,
  ): BoardMutationResult {
    return this.#inSavepoint("board_update", () => {
      const current = this.getBoard(ownerId, boardId);
      if (current?.revision !== expectedRevision) return { kind: "conflict" };
      const panels = this.#parsePanels(ownerId, input.panels);
      if (!panels.ok) return { kind: "invalid", detail: panels.detail };
      const known = new Set(current.panels.map(({ id }) => id));
      if (
        panels.panels.some(
          (panel) => panel.id !== undefined && !known.has(panel.id),
        )
      )
        return {
          kind: "invalid",
          detail: "A panel ID does not belong to this board",
        };
      this.#run(
        "UPDATE boards SET title = ?, columns = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
        input.title,
        input.columns,
        now,
        boardId,
      );
      this.#writePanels(ownerId, boardId, panels.panels, newId);
      const board = this.getBoard(ownerId, boardId);
      if (board === undefined) throw new Error("Updated board missing");
      return { kind: "applied", board };
    });
  }

  deleteBoard(
    ownerId: string,
    boardId: string,
    expectedRevision: number,
  ): "applied" | "conflict" {
    const current = this.getBoard(ownerId, boardId);
    if (current?.revision !== expectedRevision) return "conflict";
    this.#run("DELETE FROM boards WHERE id = ?", boardId);
    this.#all(
      "SELECT id FROM boards WHERE owner_id = ? ORDER BY position, id",
      ownerId,
    ).forEach((row, position) => {
      this.#run(
        "UPDATE boards SET position = ? WHERE id = ?",
        position,
        String(row.id),
      );
    });
    return "applied";
  }

  /** Full-list reorder with revisions (ADR 0019); moved boards gain a revision. */
  reorderBoards(
    ownerId: string,
    items: readonly { readonly id: string; readonly revision: number }[],
    now: string,
  ):
    | { readonly kind: "applied"; readonly boards: readonly Board[] }
    | { readonly kind: "conflict" } {
    return this.#inSavepoint("board_reorder", () => {
      const current = this.listBoards(ownerId);
      if (
        items.length !== current.length ||
        new Set(items.map(({ id }) => id)).size !== items.length ||
        !items.every((item) =>
          current.some(
            (board) => board.id === item.id && board.revision === item.revision,
          ),
        )
      )
        return { kind: "conflict" };
      items.forEach((item, position) => {
        const before = current.find((board) => board.id === item.id);
        if (before?.position !== position)
          this.#run(
            "UPDATE boards SET position = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
            position,
            now,
            item.id,
          );
      });
      return { kind: "applied", boards: this.listBoards(ownerId) };
    });
  }

  #manualOrder(panelId: string): readonly string[] {
    return this.#all(
      "SELECT task_id FROM board_panel_tasks WHERE panel_id = ? ORDER BY position",
      panelId,
    ).map((row) => String(row.task_id));
  }

  #writeManualOrder(panelId: string, taskIds: readonly string[]): void {
    this.#run("DELETE FROM board_panel_tasks WHERE panel_id = ?", panelId);
    taskIds.forEach((taskId, position) => {
      this.#run(
        "INSERT INTO board_panel_tasks (panel_id, task_id, position) VALUES (?, ?, ?)",
        panelId,
        taskId,
        position,
      );
    });
  }

  #membership(
    board: Board,
    facts: ReadonlyMap<string, BoardTaskFacts>,
    clock: BoardClock,
  ): BoardView["members"] {
    const all = [...facts.values()];
    return board.panels.map((panel) => ({
      panelId: panel.id,
      taskIds: sortPanelTasks(
        all.filter((task) => taskMatchesPanel(task, panel.filter, clock)),
        panel.filter,
        this.#manualOrder(panel.id),
      ).map(({ id }) => id),
    }));
  }

  /** The board with its computed panel membership and task markers. */
  viewBoard(
    ownerId: string,
    boardId: string,
    clock: BoardClock,
  ): BoardView | undefined {
    const board = this.getBoard(ownerId, boardId);
    if (board === undefined) return undefined;
    const facts = this.#taskFacts(ownerId);
    const members = this.#membership(board, facts, clock);
    const markers: Record<string, BoardMarker[]> = {};
    for (const { taskIds } of members)
      for (const taskId of taskIds) {
        const task = facts.get(taskId);
        if (task !== undefined && markers[taskId] === undefined)
          markers[taskId] = [...task.markers];
      }
    return { board, today: clock.today, members, markers };
  }

  /** Full-list manual order of the panel's current members. */
  reorderPanel(
    ownerId: string,
    boardId: string,
    panelId: string,
    expectedRevision: number,
    taskIds: readonly string[],
    clock: BoardClock,
    now: string,
  ): BoardMutationResult {
    return this.#inSavepoint("board_panel_order", () => {
      const board = this.getBoard(ownerId, boardId);
      if (board?.revision !== expectedRevision) return { kind: "conflict" };
      const panel = board.panels.find(({ id }) => id === panelId);
      if (panel === undefined)
        return {
          kind: "invalid",
          detail: "The panel does not belong to this board",
        };
      if (panel.filter.sortBy !== null)
        return {
          kind: "invalid",
          detail:
            "The panel is sorted by a field; clear its sort to order tasks manually",
        };
      const members = this.#membership(
        board,
        this.#taskFacts(ownerId),
        clock,
      ).find((entry) => entry.panelId === panelId);
      const current = members?.taskIds ?? [];
      const present = new Set(current);
      if (
        taskIds.length !== present.size ||
        new Set(taskIds).size !== taskIds.length ||
        !taskIds.every((id) => present.has(id))
      )
        return { kind: "conflict" };
      if (sameList(this.#manualOrder(panelId), taskIds))
        return { kind: "applied", board };
      this.#writeManualOrder(panelId, taskIds);
      this.#run(
        "UPDATE boards SET revision = revision + 1, updated_at = ? WHERE id = ?",
        now,
        boardId,
      );
      const updated = this.getBoard(ownerId, boardId);
      if (updated === undefined) throw new Error("Board missing after reorder");
      return { kind: "applied", board: updated };
    });
  }

  /** The changes a move would apply, without applying them. */
  planMove(
    ownerId: string,
    boardId: string,
    panelId: string,
    taskId: string,
    clock: BoardClock,
  ):
    | {
        readonly kind: "planned";
        readonly changes: readonly BoardMoveChange[];
        readonly taskRevision: number;
      }
    | { readonly kind: "invalid"; readonly detail: string }
    | { readonly kind: "not-found" } {
    const board = this.getBoard(ownerId, boardId);
    const panel = board?.panels.find(({ id }) => id === panelId);
    if (board === undefined || panel === undefined)
      return { kind: "not-found" };
    const task = this.#taskFacts(ownerId).get(taskId);
    const revision = this.#deps.currentTaskRevision(ownerId, taskId);
    if (task === undefined || revision === undefined)
      return {
        kind: "invalid",
        detail: "Only active tasks can be moved into a panel",
      };
    const plan = planPanelMove(task, panel.filter, clock);
    if (!plan.ok) return { kind: "invalid", detail: plan.reason };
    return { kind: "planned", changes: plan.changes, taskRevision: revision };
  }

  /**
   * Moves a task into a panel: applies the planned changes to the task (each
   * one an ordinary task mutation with the task's revision), stores marker
   * changes, and ranks the task in the panel's manual order. All or nothing.
   */
  moveTask(
    ownerId: string,
    boardId: string,
    panelId: string,
    input: {
      readonly expectedRevision: number;
      readonly taskId: string;
      readonly taskRevision: number;
      readonly position?: number | undefined;
    },
    clock: BoardClock,
    now: string,
  ): BoardMoveResult {
    return this.#inSavepoint("board_move", () => {
      const board = this.getBoard(ownerId, boardId);
      if (board?.revision !== input.expectedRevision)
        return { kind: "conflict" };
      const panel = board.panels.find(({ id }) => id === panelId);
      if (panel === undefined)
        return {
          kind: "invalid",
          detail: "The panel does not belong to this board",
        };
      const facts = this.#taskFacts(ownerId);
      const task = facts.get(input.taskId);
      const revision = this.#deps.currentTaskRevision(ownerId, input.taskId);
      if (task === undefined || revision === undefined)
        return {
          kind: "invalid",
          detail: "Only active tasks can be moved into a panel",
        };
      if (revision !== input.taskRevision) return { kind: "task-conflict" };
      const plan = planPanelMove(task, panel.filter, clock);
      if (!plan.ok) return { kind: "invalid", detail: plan.reason };
      let taskRevision = revision;
      const tags = new Set(task.tagIds);
      const markers = new Set<StoredMarker>(task.markers);
      const tagChanges = plan.changes.filter(
        (change) => change.kind === "add_tag" || change.kind === "remove_tag",
      );
      for (const change of tagChanges)
        if (change.kind === "add_tag") tags.add(change.tagId);
        else tags.delete(change.tagId);
      const fail = (): BoardMoveResult => {
        throw new MoveFailed();
      };
      try {
        if (tagChanges.length > 0) {
          if (
            !this.#deps.setTags(
              ownerId,
              input.taskId,
              [...tags],
              taskRevision,
              now,
            )
          )
            return fail();
          taskRevision++;
        }
        for (const change of plan.changes) {
          switch (change.kind) {
            case "add_marker":
              if (change.marker !== "today") markers.add(change.marker);
              break;
            case "remove_marker":
              if (change.marker !== "today") markers.delete(change.marker);
              break;
            case "complete":
            case "reopen":
              if (
                !this.#deps.setCompleted(
                  ownerId,
                  input.taskId,
                  taskRevision,
                  change.kind === "complete",
                  now,
                )
              )
                return fail();
              taskRevision++;
              break;
            case "assign_project":
              if (
                !this.#deps.assignProject(
                  ownerId,
                  input.taskId,
                  change.projectId,
                  taskRevision,
                  now,
                )
              )
                return fail();
              taskRevision++;
              break;
            case "plan_today":
            case "clear_planned_day": {
              const outcome = this.#deps.setPlannedDay(
                ownerId,
                input.taskId,
                taskRevision,
                change.kind === "plan_today" ? change.date : null,
                now,
              );
              if (outcome === "blocked") throw new MoveBlocked();
              if (outcome === "conflict") return fail();
              taskRevision++;
              break;
            }
            case "add_to_backlog":
            case "remove_from_backlog": {
              const projectId =
                plan.changes.find((c) => c.kind === "assign_project")
                  ?.projectId ?? task.projectId;
              if (
                projectId === null ||
                !this.#deps.setBacklog(
                  ownerId,
                  projectId,
                  input.taskId,
                  change.kind === "add_to_backlog",
                  now,
                )
              )
                throw new MoveBlocked(
                  "The task needs a project with an enabled backlog before it can be moved into this panel",
                );
              break;
            }
            default:
              break;
          }
        }
      } catch (error) {
        if (error instanceof MoveFailed) return { kind: "task-conflict" };
        if (error instanceof MoveBlocked)
          return { kind: "invalid", detail: error.message };
        throw error;
      }
      this.#setMarkers(ownerId, input.taskId, [...markers]);
      // Rank the task among the panel's members after the changes.
      const members =
        this.#membership(board, this.#taskFacts(ownerId), clock).find(
          (entry) => entry.panelId === panelId,
        )?.taskIds ?? [];
      const remaining = members.filter((id) => id !== input.taskId);
      const at = Math.min(input.position ?? remaining.length, remaining.length);
      remaining.splice(at, 0, input.taskId);
      this.#writeManualOrder(panelId, remaining);
      this.#run(
        "UPDATE boards SET revision = revision + 1, updated_at = ? WHERE id = ?",
        now,
        boardId,
      );
      return { kind: "applied", changes: plan.changes };
    });
  }

  // --------------------------------------------------------------- sections

  /** Active tasks that belong to a section context, in ID order. */
  #contextMembers(
    ownerId: string,
    kind: SectionContextKind,
    contextId: string,
  ): Set<string> {
    const rows =
      kind === "project"
        ? this.#all(
            `SELECT id FROM tasks WHERE owner_id = ? AND project_id = ?
             AND deleted_at IS NULL AND archived_at IS NULL`,
            ownerId,
            contextId,
          )
        : this.#all(
            `SELECT t.id FROM tasks t JOIN task_tags tt ON tt.task_id = t.id
             WHERE t.owner_id = ? AND tt.tag_id = ?
               AND t.deleted_at IS NULL AND t.archived_at IS NULL`,
            ownerId,
            contextId,
          );
    return new Set(rows.map((row) => String(row.id)));
  }

  #contextExists(
    ownerId: string,
    kind: SectionContextKind,
    contextId: string,
  ): boolean {
    return (
      this.#one(
        kind === "project"
          ? "SELECT 1 FROM projects WHERE owner_id = ? AND id = ?"
          : "SELECT 1 FROM tags WHERE owner_id = ? AND id = ?",
        ownerId,
        contextId,
      ) !== undefined
    );
  }

  #sectionRows(rows: readonly Row[], ownerId: string): Section[] {
    const membersByContext = new Map<string, Set<string>>();
    return rows.map((row) => {
      const kind = row.context_kind as SectionContextKind;
      const contextId = String(row.context_id);
      const key = `${kind}:${contextId}`;
      let members = membersByContext.get(key);
      if (members === undefined) {
        members = this.#contextMembers(ownerId, kind, contextId);
        membersByContext.set(key, members);
      }
      const present = members;
      return {
        id: String(row.id),
        contextKind: kind,
        contextId,
        title: String(row.title),
        expanded: Number(row.expanded) === 1,
        position: Number(row.position),
        revision: Number(row.revision),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        taskIds: this.#all(
          "SELECT task_id FROM section_tasks WHERE section_id = ? ORDER BY position",
          String(row.id),
        )
          .map((entry) => String(entry.task_id))
          .filter((id) => present.has(id)),
      };
    });
  }

  listSections(
    ownerId: string,
    context?: {
      readonly contextKind: SectionContextKind;
      readonly contextId: string;
    },
  ): readonly Section[] {
    return this.#sectionRows(
      context === undefined
        ? this.#all(
            "SELECT * FROM sections WHERE owner_id = ? ORDER BY context_kind, context_id, position, id",
            ownerId,
          )
        : this.#all(
            "SELECT * FROM sections WHERE owner_id = ? AND context_kind = ? AND context_id = ? ORDER BY position, id",
            ownerId,
            context.contextKind,
            context.contextId,
          ),
      ownerId,
    );
  }

  getSection(ownerId: string, sectionId: string): Section | undefined {
    const row = this.#one(
      "SELECT * FROM sections WHERE owner_id = ? AND id = ?",
      ownerId,
      sectionId,
    );
    return row === undefined ? undefined : this.#sectionRows([row], ownerId)[0];
  }

  createSection(
    ownerId: string,
    input: {
      readonly contextKind: SectionContextKind;
      readonly contextId: string;
      readonly title: string;
    },
    newId: () => string,
    now: string,
  ): SectionMutationResult {
    if (!this.#contextExists(ownerId, input.contextKind, input.contextId))
      return {
        kind: "invalid",
        detail: "The section context must be a project or tag you own",
      };
    const id = newId();
    const position = Number(
      this.#one(
        "SELECT count(*) AS count FROM sections WHERE owner_id = ? AND context_kind = ? AND context_id = ?",
        ownerId,
        input.contextKind,
        input.contextId,
      )?.count ?? 0,
    );
    this.#run(
      "INSERT INTO sections (id, owner_id, context_kind, context_id, title, expanded, position, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, 1, ?, ?)",
      id,
      ownerId,
      input.contextKind,
      input.contextId,
      input.title,
      position,
      now,
      now,
    );
    return { kind: "applied", sections: this.listSections(ownerId, input) };
  }

  updateSection(
    ownerId: string,
    sectionId: string,
    expectedRevision: number,
    patch: {
      readonly title?: string | undefined;
      readonly expanded?: boolean | undefined;
      readonly taskIds?: readonly string[] | undefined;
    },
    now: string,
  ): SectionMutationResult {
    return this.#inSavepoint("section_update", () => {
      const current = this.getSection(ownerId, sectionId);
      if (current?.revision !== expectedRevision) return { kind: "conflict" };
      const context = {
        contextKind: current.contextKind,
        contextId: current.contextId,
      };
      if (patch.taskIds !== undefined) {
        const members = this.#contextMembers(
          ownerId,
          current.contextKind,
          current.contextId,
        );
        if (!patch.taskIds.every((id) => members.has(id)))
          return {
            kind: "invalid",
            detail:
              "Every section task must be an active task of the section's project or tag",
          };
        // A task sits in one section per context: leave the siblings.
        const moving = new Set(patch.taskIds);
        for (const sibling of this.listSections(ownerId, context))
          if (sibling.id !== sectionId) {
            const kept = sibling.taskIds.filter((id) => !moving.has(id));
            if (kept.length !== sibling.taskIds.length) {
              this.#writeSectionTasks(sibling.id, kept);
              this.#run(
                "UPDATE sections SET revision = revision + 1, updated_at = ? WHERE id = ?",
                now,
                sibling.id,
              );
            }
          }
        this.#writeSectionTasks(sectionId, patch.taskIds);
      }
      this.#run(
        "UPDATE sections SET title = ?, expanded = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
        patch.title ?? current.title,
        (patch.expanded ?? current.expanded) ? 1 : 0,
        now,
        sectionId,
      );
      return { kind: "applied", sections: this.listSections(ownerId, context) };
    });
  }

  #writeSectionTasks(sectionId: string, taskIds: readonly string[]): void {
    this.#run("DELETE FROM section_tasks WHERE section_id = ?", sectionId);
    taskIds.forEach((taskId, position) => {
      this.#run(
        "INSERT INTO section_tasks (section_id, task_id, position) VALUES (?, ?, ?)",
        sectionId,
        taskId,
        position,
      );
    });
  }

  deleteSection(
    ownerId: string,
    sectionId: string,
    expectedRevision: number,
  ): SectionMutationResult {
    return this.#inSavepoint("section_delete", () => {
      const current = this.getSection(ownerId, sectionId);
      if (current?.revision !== expectedRevision) return { kind: "conflict" };
      this.#run("DELETE FROM sections WHERE id = ?", sectionId);
      const context = {
        contextKind: current.contextKind,
        contextId: current.contextId,
      };
      this.listSections(ownerId, context).forEach((section, position) => {
        if (section.position !== position)
          this.#run(
            "UPDATE sections SET position = ? WHERE id = ?",
            position,
            section.id,
          );
      });
      return { kind: "applied", sections: this.listSections(ownerId, context) };
    });
  }

  reorderSections(
    ownerId: string,
    context: {
      readonly contextKind: SectionContextKind;
      readonly contextId: string;
    },
    items: readonly { readonly id: string; readonly revision: number }[],
    now: string,
  ): SectionMutationResult {
    return this.#inSavepoint("section_reorder", () => {
      const current = this.listSections(ownerId, context);
      if (
        items.length !== current.length ||
        new Set(items.map(({ id }) => id)).size !== items.length ||
        !items.every((item) =>
          current.some(
            (section) =>
              section.id === item.id && section.revision === item.revision,
          ),
        )
      )
        return { kind: "conflict" };
      items.forEach((item, position) => {
        if (
          current.find((section) => section.id === item.id)?.position !==
          position
        )
          this.#run(
            "UPDATE sections SET position = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
            position,
            now,
            item.id,
          );
      });
      return { kind: "applied", sections: this.listSections(ownerId, context) };
    });
  }

  // ------------------------------------------------------------- task views

  #viewFromRow(row: Row): TaskView {
    return {
      contextKind: row.context_kind as TaskViewContextKind,
      contextId: String(row.context_id),
      sortBy: (row.sort_by as TaskView["sortBy"]) ?? null,
      sortDir: row.sort_dir === "desc" ? "desc" : "asc",
      groupBy: (row.group_by as TaskView["groupBy"]) ?? null,
      filter: JSON.parse(String(row.filter_json)) as TaskView["filter"],
      collapsedGroups: JSON.parse(String(row.collapsed_json)) as string[],
      revision: Number(row.revision),
    };
  }

  listTaskViews(ownerId: string): readonly TaskView[] {
    return this.#all(
      "SELECT * FROM task_views WHERE owner_id = ? ORDER BY context_kind, context_id",
      ownerId,
    ).map((row) => this.#viewFromRow(row));
  }

  getTaskView(
    ownerId: string,
    contextKind: TaskViewContextKind,
    contextId: string,
  ): TaskView {
    const row = this.#one(
      "SELECT * FROM task_views WHERE owner_id = ? AND context_kind = ? AND context_id = ?",
      ownerId,
      contextKind,
      contextId,
    );
    return row === undefined
      ? {
          contextKind,
          contextId,
          sortBy: null,
          sortDir: "asc",
          groupBy: null,
          filter: null,
          collapsedGroups: [],
          revision: 0,
        }
      : this.#viewFromRow(row);
  }

  setTaskView(
    ownerId: string,
    input: TaskViewSetRequest,
    now: string,
  ): TaskViewSetResult {
    return this.#inSavepoint("task_view_set", () => {
      if (
        (input.contextKind === "project" || input.contextKind === "tag") &&
        !this.#contextExists(ownerId, input.contextKind, input.contextId)
      )
        return {
          kind: "invalid",
          detail: "The view context must be a project or tag you own",
        };
      if (
        input.filter?.kind === "tag" &&
        !this.#contextExists(ownerId, "tag", input.filter.tagId)
      )
        return {
          kind: "invalid",
          detail: "The view filter names a tag you do not own",
        };
      if (
        input.filter?.kind === "project" &&
        !this.#contextExists(ownerId, "project", input.filter.projectId)
      )
        return {
          kind: "invalid",
          detail: "The view filter names a project you do not own",
        };
      const current = this.getTaskView(
        ownerId,
        input.contextKind,
        input.contextId,
      );
      if (current.revision !== input.expectedRevision)
        return { kind: "conflict" };
      const values = [
        input.sortBy,
        input.sortDir,
        input.groupBy,
        JSON.stringify(input.filter),
        JSON.stringify(input.collapsedGroups),
      ] as const;
      if (current.revision === 0)
        this.#run(
          "INSERT INTO task_views (owner_id, context_kind, context_id, sort_by, sort_dir, group_by, filter_json, collapsed_json, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
          ownerId,
          input.contextKind,
          input.contextId,
          ...values,
          now,
        );
      else
        this.#run(
          "UPDATE task_views SET sort_by = ?, sort_dir = ?, group_by = ?, filter_json = ?, collapsed_json = ?, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND context_kind = ? AND context_id = ?",
          ...values,
          now,
          ownerId,
          input.contextKind,
          input.contextId,
        );
      return {
        kind: "applied",
        view: this.getTaskView(ownerId, input.contextKind, input.contextId),
      };
    });
  }

  // ----------------------------------------------------------- menu folders

  #folderRows(rows: readonly Row[]): MenuFolder[] {
    return rows.map((row) => ({
      id: String(row.id),
      kind: row.kind as MenuFolderKind,
      parentId: row.parent_id === null ? null : String(row.parent_id),
      title: String(row.title),
      expanded: Number(row.expanded) === 1,
      position: Number(row.position),
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      itemIds: this.#all(
        "SELECT item_id FROM menu_folder_items WHERE folder_id = ? ORDER BY position",
        String(row.id),
      ).map((entry) => String(entry.item_id)),
    }));
  }

  /** Every folder of the owner (or one kind), parents before children. */
  listMenuFolders(
    ownerId: string,
    kind?: MenuFolderKind,
  ): readonly MenuFolder[] {
    const rows = this.#folderRows(
      kind === undefined
        ? this.#all(
            "SELECT * FROM menu_folders WHERE owner_id = ? ORDER BY kind, parent_id, position, id",
            ownerId,
          )
        : this.#all(
            "SELECT * FROM menu_folders WHERE owner_id = ? AND kind = ? ORDER BY parent_id, position, id",
            ownerId,
            kind,
          ),
    );
    // Depth-first from the roots so consumers can build the tree in one pass.
    const byParent = new Map<string | null, MenuFolder[]>();
    for (const folder of rows)
      byParent.set(folder.parentId, [
        ...(byParent.get(folder.parentId) ?? []),
        folder,
      ]);
    const ordered: MenuFolder[] = [];
    const visit = (parentId: string | null): void => {
      for (const folder of (byParent.get(parentId) ?? []).toSorted(
        (a, b) => a.kind.localeCompare(b.kind) || a.position - b.position,
      )) {
        ordered.push(folder);
        visit(folder.id);
      }
    };
    visit(null);
    return ordered;
  }

  #siblings(
    ownerId: string,
    kind: MenuFolderKind,
    parentId: string | null,
  ): MenuFolder[] {
    return this.#folderRows(
      this.#all(
        "SELECT * FROM menu_folders WHERE owner_id = ? AND kind = ? AND parent_id IS ? ORDER BY position, id",
        ownerId,
        kind,
        parentId,
      ),
    );
  }

  /** Depth of a folder (0 at the top level), or -1 for an unknown ID. */
  #depth(ownerId: string, folderId: string | null): number {
    let depth = -1;
    let current = folderId;
    while (current !== null) {
      const row = this.#one(
        "SELECT parent_id FROM menu_folders WHERE owner_id = ? AND id = ?",
        ownerId,
        current,
      );
      if (row === undefined) return -1;
      current = row.parent_id === null ? null : String(row.parent_id);
      depth++;
      if (depth > menuFolderMaxDepth) break;
    }
    return depth;
  }

  #isAncestor(
    ownerId: string,
    folderId: string,
    candidate: string | null,
  ): boolean {
    let current = candidate;
    for (let step = 0; current !== null && step <= menuFolderMaxDepth; step++) {
      if (current === folderId) return true;
      const row = this.#one(
        "SELECT parent_id FROM menu_folders WHERE owner_id = ? AND id = ?",
        ownerId,
        current,
      );
      current = row?.parent_id == null ? null : String(row.parent_id);
    }
    return false;
  }

  #validParent(
    ownerId: string,
    kind: MenuFolderKind,
    parentId: string | null,
    folderId?: string,
  ): string | undefined {
    if (parentId === null) return undefined;
    const parent = this.getMenuFolder(ownerId, parentId);
    if (parent?.kind !== kind)
      return `The parent must be a ${kind} folder you own`;
    if (folderId !== undefined && this.#isAncestor(ownerId, folderId, parentId))
      return "A folder cannot be moved into itself or one of its subfolders";
    if (this.#depth(ownerId, parentId) + 1 >= menuFolderMaxDepth)
      return `Folders nest at most ${String(menuFolderMaxDepth)} levels deep`;
    return undefined;
  }

  getMenuFolder(ownerId: string, folderId: string): MenuFolder | undefined {
    const row = this.#one(
      "SELECT * FROM menu_folders WHERE owner_id = ? AND id = ?",
      ownerId,
      folderId,
    );
    return row === undefined ? undefined : this.#folderRows([row])[0];
  }

  #validItems(
    ownerId: string,
    kind: MenuFolderKind,
    itemIds: readonly string[],
  ): boolean {
    return itemIds.every((itemId) =>
      this.#contextExists(ownerId, kind, itemId),
    );
  }

  #writeFolderItems(
    ownerId: string,
    kind: MenuFolderKind,
    folderId: string,
    itemIds: readonly string[],
    now: string,
  ): void {
    // An item is in one folder: leave the others and bump their revision.
    for (const other of this.listMenuFolders(ownerId, kind))
      if (other.id !== folderId) {
        const kept = other.itemIds.filter((id) => !itemIds.includes(id));
        if (kept.length !== other.itemIds.length) {
          this.#run(
            "DELETE FROM menu_folder_items WHERE folder_id = ?",
            other.id,
          );
          kept.forEach((itemId, position) => {
            this.#run(
              "INSERT INTO menu_folder_items (folder_id, item_id, position) VALUES (?, ?, ?)",
              other.id,
              itemId,
              position,
            );
          });
          this.#run(
            "UPDATE menu_folders SET revision = revision + 1, updated_at = ? WHERE id = ?",
            now,
            other.id,
          );
        }
      }
    this.#run("DELETE FROM menu_folder_items WHERE folder_id = ?", folderId);
    itemIds.forEach((itemId, position) => {
      this.#run(
        "INSERT INTO menu_folder_items (folder_id, item_id, position) VALUES (?, ?, ?)",
        folderId,
        itemId,
        position,
      );
    });
  }

  createMenuFolder(
    ownerId: string,
    input: {
      readonly kind: MenuFolderKind;
      readonly parentId?: string | null | undefined;
      readonly title: string;
      readonly itemIds: readonly string[];
    },
    newId: () => string,
    now: string,
  ): MenuFolderMutationResult {
    return this.#inSavepoint("menu_folder_create", () => {
      if (!this.#validItems(ownerId, input.kind, input.itemIds))
        return {
          kind: "invalid",
          detail: `Every folder item must be a ${input.kind} you own`,
        };
      const parentId = input.parentId ?? null;
      const parentProblem = this.#validParent(ownerId, input.kind, parentId);
      if (parentProblem !== undefined)
        return { kind: "invalid", detail: parentProblem };
      const id = newId();
      const position = this.#siblings(ownerId, input.kind, parentId).length;
      this.#run(
        "INSERT INTO menu_folders (id, owner_id, kind, parent_id, title, expanded, position, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, 1, ?, ?)",
        id,
        ownerId,
        input.kind,
        parentId,
        input.title,
        position,
        now,
        now,
      );
      this.#writeFolderItems(ownerId, input.kind, id, input.itemIds, now);
      return {
        kind: "applied",
        folders: this.listMenuFolders(ownerId, input.kind),
      };
    });
  }

  updateMenuFolder(
    ownerId: string,
    folderId: string,
    expectedRevision: number,
    patch: {
      readonly title?: string | undefined;
      readonly expanded?: boolean | undefined;
      readonly parentId?: string | null | undefined;
      readonly itemIds?: readonly string[] | undefined;
    },
    now: string,
  ): MenuFolderMutationResult {
    return this.#inSavepoint("menu_folder_update", () => {
      const current = this.getMenuFolder(ownerId, folderId);
      if (current?.revision !== expectedRevision) return { kind: "conflict" };
      if (patch.itemIds !== undefined) {
        if (!this.#validItems(ownerId, current.kind, patch.itemIds))
          return {
            kind: "invalid",
            detail: `Every folder item must be a ${current.kind} you own`,
          };
        this.#writeFolderItems(
          ownerId,
          current.kind,
          folderId,
          patch.itemIds,
          now,
        );
      }
      if (patch.parentId !== undefined && patch.parentId !== current.parentId) {
        const problem = this.#validParent(
          ownerId,
          current.kind,
          patch.parentId,
          folderId,
        );
        if (problem !== undefined) return { kind: "invalid", detail: problem };
        this.#run(
          "UPDATE menu_folders SET parent_id = ?, position = ? WHERE id = ?",
          patch.parentId,
          this.#siblings(ownerId, current.kind, patch.parentId).length,
          folderId,
        );
        this.#compactSiblings(ownerId, current.kind, current.parentId);
      }
      this.#run(
        "UPDATE menu_folders SET title = ?, expanded = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
        patch.title ?? current.title,
        (patch.expanded ?? current.expanded) ? 1 : 0,
        now,
        folderId,
      );
      return {
        kind: "applied",
        folders: this.listMenuFolders(ownerId, current.kind),
      };
    });
  }

  deleteMenuFolder(
    ownerId: string,
    folderId: string,
    expectedRevision: number,
  ): MenuFolderMutationResult {
    return this.#inSavepoint("menu_folder_delete", () => {
      const current = this.getMenuFolder(ownerId, folderId);
      if (current?.revision !== expectedRevision) return { kind: "conflict" };
      this.#run("DELETE FROM menu_folders WHERE id = ?", folderId);
      this.#compactSiblings(ownerId, current.kind, current.parentId);
      return {
        kind: "applied",
        folders: this.listMenuFolders(ownerId, current.kind),
      };
    });
  }

  #compactSiblings(
    ownerId: string,
    kind: MenuFolderKind,
    parentId: string | null,
  ): void {
    this.#siblings(ownerId, kind, parentId).forEach((folder, position) => {
      if (folder.position !== position)
        this.#run(
          "UPDATE menu_folders SET position = ? WHERE id = ?",
          position,
          folder.id,
        );
    });
  }

  /** Full-list reorder of the folders that share one parent. */
  reorderMenuFolders(
    ownerId: string,
    kind: MenuFolderKind,
    parentId: string | null,
    items: readonly { readonly id: string; readonly revision: number }[],
    now: string,
  ): MenuFolderMutationResult {
    return this.#inSavepoint("menu_folder_reorder", () => {
      const current = this.#siblings(ownerId, kind, parentId);
      if (
        items.length !== current.length ||
        new Set(items.map(({ id }) => id)).size !== items.length ||
        !items.every((item) =>
          current.some(
            (folder) =>
              folder.id === item.id && folder.revision === item.revision,
          ),
        )
      )
        return { kind: "conflict" };
      items.forEach((item, position) => {
        if (
          current.find((folder) => folder.id === item.id)?.position !== position
        )
          this.#run(
            "UPDATE menu_folders SET position = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
            position,
            now,
            item.id,
          );
      });
      return { kind: "applied", folders: this.listMenuFolders(ownerId, kind) };
    });
  }

  // --------------------------------------------------------------- shared

  /** Current revision of a board, section or folder for confirmation checks. */
  entityRevision(
    ownerId: string,
    entityId: string,
  ): { readonly id: string; readonly revision: number } | undefined {
    for (const table of ["boards", "sections", "menu_folders"]) {
      const row = this.#one(
        `SELECT id, revision FROM ${table} WHERE owner_id = ? AND id = ?`,
        ownerId,
        entityId,
      );
      if (row !== undefined)
        return { id: String(row.id), revision: Number(row.revision) };
    }
    return undefined;
  }

  #importedFolderId(ownerId: string, sourceId: string): string | null {
    const row = this.#one(
      "SELECT target_id FROM task_import_sources WHERE owner_id=? AND source_kind='super_productivity' AND entity_kind='menu_folder' AND source_id=?",
      ownerId,
      sourceId,
    );
    if (row === undefined) return null;
    const id = String(row.target_id);
    return this.getMenuFolder(ownerId, id) === undefined ? null : id;
  }

  /**
   * Super Productivity import (ADR 0028), inside the import transaction.
   * Each board, section and folder is recorded once by source ID; a repeated
   * import with the same source bytes is a no-op and a changed source fails
   * the whole import. Markers are applied to newly imported tasks only.
   */
  importInTransaction(
    ownerId: string,
    input: ImportedBoardData,
    resolve: (
      kind: "task" | "project" | "tag",
      sourceId: string,
    ) => string | undefined,
    newTaskIds: ReadonlySet<string>,
    newId: () => string,
    now: string,
  ): { boards: number; sections: number; folders: number; existing: number } {
    const counts = { boards: 0, sections: 0, folders: 0, existing: 0 };
    const prior = this.#database.prepare(
      "SELECT source_hash FROM task_import_sources WHERE owner_id=? AND source_kind='super_productivity' AND entity_kind=? AND source_id=?",
    );
    const provenance = this.#database.prepare(
      "INSERT INTO task_import_sources (owner_id,source_kind,entity_kind,source_id,target_id,source_hash,source_json,imported_at) VALUES (?,'super_productivity',?,?,?,?,?,?)",
    );
    const record = (
      entityKind: "board" | "section" | "menu_folder",
      sourceId: string,
      sourceJson: string,
      insert: (id: string) => void,
    ): boolean => {
      const sourceHash = sha256(sourceJson);
      const before = prior.get(ownerId, entityKind, sourceId) as
        { source_hash: string } | undefined;
      if (before !== undefined) {
        if (before.source_hash !== sourceHash)
          throw new Error("IMPORT_SOURCE_CHANGED");
        counts.existing++;
        return false;
      }
      const id = newId();
      insert(id);
      provenance.run(
        ownerId,
        entityKind,
        sourceId,
        id,
        sourceHash,
        sourceJson,
        now,
      );
      return true;
    };
    const tasks = (sourceIds: readonly string[]): string[] =>
      sourceIds.flatMap((sourceId) => {
        const id = resolve("task", sourceId);
        return id === undefined ? [] : [id];
      });
    for (const board of input.boards)
      if (
        record("board", board.sourceId, board.sourceJson, (id) => {
          const created = this.createBoard(
            ownerId,
            {
              title: board.title,
              columns: board.columns,
              panels: board.panels.map((panel) => ({
                title: panel.title,
                filter: panel.filter,
              })),
            },
            (() => {
              let first = true;
              return () => {
                if (first) {
                  first = false;
                  return id;
                }
                return newId();
              };
            })(),
            now,
          );
          if (created.kind !== "applied")
            throw new Error("IMPORT_BOARD_INVALID");
          created.board.panels.forEach((panel, index) => {
            const order = tasks(board.panels[index]?.sourceTaskIds ?? []);
            if (order.length > 0) this.#writeManualOrder(panel.id, order);
          });
        })
      )
        counts.boards++;
    for (const section of input.sections)
      if (
        record("section", section.sourceId, section.sourceJson, (id) => {
          const contextId = resolve(
            section.contextKind,
            section.sourceContextId,
          );
          if (contextId === undefined)
            throw new Error("IMPORT_SECTION_CONTEXT_MISSING");
          const position = Number(
            this.#one(
              "SELECT count(*) AS count FROM sections WHERE owner_id = ? AND context_kind = ? AND context_id = ?",
              ownerId,
              section.contextKind,
              contextId,
            )?.count ?? 0,
          );
          this.#run(
            "INSERT INTO sections (id, owner_id, context_kind, context_id, title, expanded, position, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
            id,
            ownerId,
            section.contextKind,
            contextId,
            section.title,
            section.expanded ? 1 : 0,
            position,
            now,
            now,
          );
          const members = this.#contextMembers(
            ownerId,
            section.contextKind,
            contextId,
          );
          this.#writeSectionTasks(
            id,
            tasks(section.sourceTaskIds).filter((taskId) =>
              members.has(taskId),
            ),
          );
        })
      )
        counts.sections++;
    const folderIds = new Map<string, string>();
    for (const folder of input.folders) {
      const parentId =
        folder.sourceParentId === null
          ? null
          : (folderIds.get(folder.sourceParentId) ??
            this.#importedFolderId(ownerId, folder.sourceParentId));
      if (
        record("menu_folder", folder.sourceId, folder.sourceJson, (id) => {
          folderIds.set(folder.sourceId, id);
          const position = this.#siblings(
            ownerId,
            folder.kind,
            parentId,
          ).length;
          this.#run(
            "INSERT INTO menu_folders (id, owner_id, kind, parent_id, title, expanded, position, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
            id,
            ownerId,
            folder.kind,
            parentId,
            folder.title,
            folder.expanded ? 1 : 0,
            position,
            now,
            now,
          );
          const itemIds = folder.sourceItemIds.flatMap((sourceId) => {
            const itemId = resolve(folder.kind, sourceId);
            return itemId === undefined ? [] : [itemId];
          });
          // Items already placed by an earlier import keep their folder.
          const free = itemIds.filter(
            (itemId) =>
              this.#one(
                "SELECT 1 FROM menu_folder_items WHERE item_id = ?",
                itemId,
              ) === undefined,
          );
          free.forEach((itemId, index) => {
            this.#run(
              "INSERT INTO menu_folder_items (folder_id, item_id, position) VALUES (?, ?, ?)",
              id,
              itemId,
              index,
            );
          });
        })
      )
        counts.folders++;
    }
    for (const entry of input.taskMarkers) {
      const taskId = resolve("task", entry.sourceTaskId);
      if (
        taskId !== undefined &&
        newTaskIds.has(taskId) &&
        entry.markers.length > 0
      )
        this.#setMarkers(ownerId, taskId, entry.markers);
    }
    return counts;
  }
}

class MoveFailed extends Error {}
class MoveBlocked extends Error {
  constructor(
    message = "The task has a calendar block; remove it before moving the task out of today",
  ) {
    super(message);
  }
}
