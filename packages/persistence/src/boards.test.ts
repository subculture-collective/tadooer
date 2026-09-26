import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import { SuiteDatabase, type TaskRecord } from "./index.ts";
import type { ImportedBoardData } from "./board-store.ts";

// Boards, sections, saved views and folders (issue #63, ADR 0028).
const now = "2026-09-24T12:00:00.000Z";
const later = "2026-09-24T13:00:00.000Z";
const owner = "board-owner";
const other = "other-owner";
const clock = { today: "2026-09-25", timeZone: "America/Chicago" };
let counter = 0;
const uuid = () => {
  counter++;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
};

const open = (path: string): SuiteDatabase => {
  const database = SuiteDatabase.open(path);
  if (database.findOwnerById(owner) === undefined) {
    database.createOwner({
      id: owner,
      username: owner,
      displayName: owner,
      passwordHash: "hash",
      createdAt: now,
    });
    // A second, disabled account exercises owner isolation (ADR 0003 keeps
    // one active owner per deployment).
    const fixture = new DatabaseSync(path);
    fixture
      .prepare(
        "INSERT INTO owner_accounts (id,username,display_name,password_hash,created_at,disabled_at) VALUES (?,?,?,?,?,?)",
      )
      .run(other, other, other, "hash", now, now);
    fixture.close();
  }
  return database;
};

const createTask = (
  database: SuiteDatabase,
  ownerId: string,
  title: string,
  fields: Partial<TaskRecord> = {},
): TaskRecord => {
  const id = uuid();
  const result = database.createTaskIdempotently(ownerId, id, id, {
    id,
    title,
    notes: "",
    status: "open",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    ...fields,
  });
  if (result.kind !== "created") throw new Error("task was not created");
  return result.task;
};

const createTag = (database: SuiteDatabase, ownerId: string, title: string) => {
  const id = uuid();
  database.createTag({
    id,
    ownerId,
    title,
    normalizedName: title.toLowerCase(),
    revision: 1,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  return id;
};

const createProject = (
  database: SuiteDatabase,
  ownerId: string,
  title: string,
) => {
  const id = uuid();
  database.createProject({
    id,
    ownerId,
    title,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  return id;
};

const withDatabase = async (
  run: (database: SuiteDatabase, directory: string) => void,
) =>
  withTemporaryDirectory((directory) => {
    const database = open(join(directory, "suite.sqlite"));
    try {
      run(database, directory);
    } finally {
      database.close();
    }
  });

/** The value a lookup or index must produce in this test. */
const defined = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("expected a value");
  return value;
};

const applied = <T extends { kind: string }>(
  result: T,
): Extract<T, { kind: "applied" }> => {
  if (result.kind !== "applied")
    throw new Error(`expected applied, got ${result.kind}`);
  return result as Extract<T, { kind: "applied" }>;
};

describe("boards", () => {
  it("creates templates, computes membership from markers and today, and moves tasks explicitly", async () => {
    await withDatabase((db) => {
      const board = applied(
        db.boards.createBoard(owner, { template: "kanban" }, uuid, now),
      ).board;
      expect(board.panels.map(({ title }) => title)).toEqual([
        "To do",
        "In progress",
        "Done",
      ]);
      const [todo, doing, done] = board.panels.map(({ id }) => id) as [
        string,
        string,
        string,
      ];
      const a = createTask(db, owner, "Alpha");
      const b = createTask(db, owner, "Beta");
      const c = createTask(db, owner, "Gamma", {
        status: "completed",
        completedAt: now,
      });
      const view = db.boards.viewBoard(owner, board.id, clock);
      expect(view?.members).toEqual([
        { panelId: todo, taskIds: [a.id, b.id] },
        { panelId: doing, taskIds: [] },
        { panelId: done, taskIds: [c.id] },
      ]);

      // Moving into "In progress" marks the task; the task revision advances.
      const plan = db.boards.planMove(owner, board.id, doing, a.id, clock);
      expect(plan).toEqual({
        kind: "planned",
        changes: [{ kind: "add_marker", marker: "in_progress" }],
        taskRevision: 1,
      });
      expect(
        db.boards.moveTask(
          owner,
          board.id,
          doing,
          { expectedRevision: board.revision, taskId: a.id, taskRevision: 9 },
          clock,
          later,
        ),
      ).toEqual({ kind: "task-conflict" });
      expect(
        db.boards.moveTask(
          owner,
          board.id,
          doing,
          { expectedRevision: 7, taskId: a.id, taskRevision: 1 },
          clock,
          later,
        ),
      ).toEqual({ kind: "conflict" });
      const moved = db.boards.moveTask(
        owner,
        board.id,
        doing,
        { expectedRevision: board.revision, taskId: a.id, taskRevision: 1 },
        clock,
        later,
      );
      expect(moved).toEqual({
        kind: "applied",
        changes: [{ kind: "add_marker", marker: "in_progress" }],
      });
      expect(db.boards.markersOf(owner, a.id)).toEqual(["in_progress"]);
      expect(db.getTask(owner, a.id)?.revision).toBe(1);
      expect(db.getTask(owner, a.id)?.tagIds).toEqual([]);
      const after = db.boards.viewBoard(owner, board.id, clock);
      expect(after?.board.revision).toBe(2);
      expect(after?.members[1]).toEqual({ panelId: doing, taskIds: [a.id] });
      expect(after?.markers[a.id]).toEqual(["in_progress"]);

      // Moving into "Done" completes the task and clears the marker on read of the To do panel.
      const completed = db.boards.moveTask(
        owner,
        board.id,
        done,
        { expectedRevision: 2, taskId: a.id, taskRevision: 1, position: 0 },
        clock,
        later,
      );
      expect(completed).toEqual({
        kind: "applied",
        changes: [{ kind: "complete" }],
      });
      expect(db.getTask(owner, a.id)).toMatchObject({
        status: "completed",
        revision: 2,
      });
      expect(db.boards.viewBoard(owner, board.id, clock)?.members[2]).toEqual({
        panelId: done,
        taskIds: [a.id, c.id],
      });

      // Manual order: full list of current members, stale revisions fail.
      expect(
        db.boards.reorderPanel(owner, board.id, done, 3, [c.id], clock, later)
          .kind,
      ).toBe("conflict");
      expect(
        db.boards.reorderPanel(
          owner,
          board.id,
          done,
          2,
          [c.id, a.id],
          clock,
          later,
        ).kind,
      ).toBe("conflict");
      expect(
        db.boards.reorderPanel(
          owner,
          board.id,
          done,
          3,
          [c.id, a.id],
          clock,
          later,
        ).kind,
      ).toBe("applied");
      expect(
        db.boards.viewBoard(owner, board.id, clock)?.members[2]?.taskIds,
      ).toEqual([c.id, a.id]);
      // Deleted and archived tasks leave every panel quietly.
      expect(db.deleteTask(owner, c.id, c.revision, later).kind).toBe(
        "updated",
      );
      expect(
        db.taskArchive.archive({
          ownerId: owner,
          taskId: a.id,
          expectedRevision: 2,
          now: later,
        }).kind,
      ).toBe("archived");
      expect(
        db.boards.viewBoard(owner, board.id, clock)?.members[2]?.taskIds,
      ).toEqual([]);
      expect(
        db.boards.reorderPanel(owner, board.id, done, 4, [], clock, later).kind,
      ).toBe("applied");
    });
  });

  it("applies tag, project, today and backlog changes and refuses moves it cannot make true", async () => {
    await withDatabase((db) => {
      const tag = createTag(db, owner, "Deep");
      const project = createProject(db, owner, "P");
      const board = applied(
        db.boards.createBoard(
          owner,
          {
            title: "Custom",
            columns: 2,
            panels: [
              {
                title: "Tagged today",
                filter: {
                  includedTagIds: [tag],
                  includedMarkers: ["today"],
                  projectIds: [project],
                },
              },
              {
                title: "Backlog only",
                filter: { backlogState: "only_backlog" },
              },
              { title: "Parents", filter: { parentsOnly: true } },
            ],
          },
          uuid,
          now,
        ),
      ).board;
      const [tagged, backlog, parents] = board.panels.map(({ id }) => id) as [
        string,
        string,
        string,
      ];
      const task = createTask(db, owner, "Loose");
      const moved = db.boards.moveTask(
        owner,
        board.id,
        tagged,
        { expectedRevision: 1, taskId: task.id, taskRevision: 1 },
        clock,
        later,
      );
      expect(moved).toEqual({
        kind: "applied",
        changes: [
          { kind: "add_tag", tagId: tag },
          { kind: "plan_today", date: clock.today },
          { kind: "assign_project", projectId: project },
        ],
      });
      expect(db.getTask(owner, task.id)).toMatchObject({
        tagIds: [tag],
        plannedDay: clock.today,
        projectId: project,
        revision: 4,
      });
      expect(
        db.boards.viewBoard(owner, board.id, clock)?.members[0]?.taskIds,
      ).toEqual([task.id]);
      // Backlog needs an enabled project backlog.
      expect(
        db.boards.moveTask(
          owner,
          board.id,
          backlog,
          { expectedRevision: 2, taskId: task.id, taskRevision: 4 },
          clock,
          later,
        ).kind,
      ).toBe("invalid");
      expect(db.getTask(owner, task.id)?.revision).toBe(4);
      const child = db.taskHierarchy.createChild({
        ownerId: owner,
        parentId: task.id,
        now: later,
        create: () => ({
          kind: "created",
          task: createTask(db, owner, "Child"),
        }),
      });
      if (child.kind !== "created") throw new Error("child not created");
      expect(
        db.boards.moveTask(
          owner,
          board.id,
          parents,
          {
            expectedRevision: 2,
            taskId: child.task.id,
            taskRevision: child.task.revision,
          },
          clock,
          later,
        ),
      ).toMatchObject({ kind: "invalid" });
      // Filters name only the owner's tags and projects; panel edits replace the set.
      expect(
        db.boards.updateBoard(
          owner,
          board.id,
          2,
          {
            title: "Custom",
            columns: 1,
            panels: [{ title: "Bad", filter: { includedTagIds: [uuid()] } }],
          },
          uuid,
          later,
        ).kind,
      ).toBe("invalid");
      const updated = applied(
        db.boards.updateBoard(
          owner,
          board.id,
          2,
          {
            title: "Renamed",
            columns: 1,
            panels: [
              { id: backlog, title: "Only backlog" },
              { title: "Fresh" },
            ],
          },
          uuid,
          later,
        ),
      ).board;
      expect(updated).toMatchObject({ title: "Renamed", revision: 3 });
      expect(
        updated.panels.map(({ id, title }) => [id === backlog, title]),
      ).toEqual([
        [true, "Only backlog"],
        [false, "Fresh"],
      ]);
      expect(updated.panels[0]?.filter.backlogState).toBe("all");
      expect(db.boards.deleteBoard(owner, board.id, 2)).toBe("conflict");
      expect(db.boards.deleteBoard(owner, board.id, 3)).toBe("applied");
      expect(db.boards.listBoards(owner)).toEqual([]);
      // Deleting the board never changed the task.
      expect(db.getTask(owner, task.id)?.revision).toBe(4);
    });
  });

  it("isolates owners", async () => {
    await withDatabase((db) => {
      const board = applied(
        db.boards.createBoard(owner, { template: "eisenhower" }, uuid, now),
      ).board;
      const task = createTask(db, owner, "Mine");
      expect(db.boards.listBoards(other)).toEqual([]);
      expect(db.boards.getBoard(other, board.id)).toBeUndefined();
      expect(db.boards.viewBoard(other, board.id, clock)).toBeUndefined();
      expect(
        db.boards.moveTask(
          other,
          board.id,
          defined(board.panels[0]).id,
          { expectedRevision: 1, taskId: task.id, taskRevision: 1 },
          clock,
          later,
        ).kind,
      ).toBe("conflict");
      expect(db.boards.deleteBoard(other, board.id, 1)).toBe("conflict");
      // A foreign task cannot be marked through a panel of the other owner.
      const theirs = applied(
        db.boards.createBoard(other, { template: "kanban" }, uuid, now),
      ).board;
      expect(
        db.boards.moveTask(
          other,
          theirs.id,
          defined(theirs.panels[1]).id,
          { expectedRevision: 1, taskId: task.id, taskRevision: 1 },
          clock,
          later,
        ).kind,
      ).toBe("invalid");
      expect(db.boards.markersOf(owner, task.id)).toEqual([]);
      const section = defined(
        applied(
          db.boards.createSection(
            owner,
            {
              contextKind: "project",
              contextId: createProject(db, owner, "P"),
              title: "S",
            },
            uuid,
            now,
          ),
        ).sections[0],
      );
      expect(db.boards.getSection(other, section.id)).toBeUndefined();
      expect(
        db.boards.updateSection(other, section.id, 1, { title: "X" }, later)
          .kind,
      ).toBe("conflict");
      expect(db.boards.entityRevision(other, section.id)).toBeUndefined();
      expect(db.boards.entityRevision(owner, section.id)).toEqual({
        id: section.id,
        revision: 1,
      });
    });
  });
});

describe("sections", () => {
  it("keeps ordered members of a project or tag, one section per task, and prunes leavers", async () => {
    await withDatabase((db) => {
      const project = createProject(db, owner, "P");
      const context = { contextKind: "project" as const, contextId: project };
      const a = createTask(db, owner, "A", { projectId: project });
      const b = createTask(db, owner, "B", { projectId: project });
      const outside = createTask(db, owner, "Outside");
      expect(
        db.boards.createSection(
          owner,
          { contextKind: "tag", contextId: uuid(), title: "X" },
          uuid,
          now,
        ).kind,
      ).toBe("invalid");
      const first = defined(
        applied(
          db.boards.createSection(
            owner,
            { ...context, title: "First" },
            uuid,
            now,
          ),
        ).sections[0],
      );
      const second = defined(
        applied(
          db.boards.createSection(
            owner,
            { ...context, title: "Second" },
            uuid,
            now,
          ),
        ).sections[1],
      );
      expect(
        db.boards.updateSection(
          owner,
          first.id,
          1,
          { taskIds: [outside.id] },
          later,
        ).kind,
      ).toBe("invalid");
      expect(
        db.boards.updateSection(
          owner,
          first.id,
          2,
          { taskIds: [b.id, a.id] },
          later,
        ).kind,
      ).toBe("conflict");
      expect(
        applied(
          db.boards.updateSection(
            owner,
            first.id,
            1,
            { taskIds: [b.id, a.id] },
            later,
          ),
        ).sections[0],
      ).toMatchObject({ taskIds: [b.id, a.id], revision: 2 });
      // Placing A in the second section removes it from the first.
      const moved = applied(
        db.boards.updateSection(
          owner,
          second.id,
          1,
          { taskIds: [a.id], expanded: false },
          later,
        ),
      ).sections;
      expect(
        moved.map(({ taskIds, revision, expanded }) => [
          taskIds,
          revision,
          expanded,
        ]),
      ).toEqual([
        [[b.id], 3, true],
        [[a.id], 2, false],
      ]);
      // Reorder needs every section with its revision.
      expect(
        db.boards.reorderSections(
          owner,
          context,
          [{ id: second.id, revision: 2 }],
          later,
        ).kind,
      ).toBe("conflict");
      expect(
        applied(
          db.boards.reorderSections(
            owner,
            context,
            [
              { id: second.id, revision: 2 },
              { id: first.id, revision: 3 },
            ],
            later,
          ),
        ).sections.map(({ title, position }) => [title, position]),
      ).toEqual([
        ["Second", 0],
        ["First", 1],
      ]);
      // A task that leaves the project is ignored on read and pruned by the next write.
      expect(db.assignTaskProject(owner, b.id, null, 1, later)).toBeDefined();
      expect(db.boards.getSection(owner, first.id)?.taskIds).toEqual([]);
      expect(
        db.assignTaskProject(owner, b.id, project, 2, later),
      ).toBeDefined();
      expect(db.boards.getSection(owner, first.id)?.taskIds).toEqual([b.id]);
      expect(db.deleteTask(owner, a.id, 1, later).kind).toBe("updated");
      expect(db.boards.getSection(owner, second.id)?.taskIds).toEqual([]);
      expect(db.boards.deleteSection(owner, second.id, 1).kind).toBe(
        "conflict",
      );
      expect(
        applied(db.boards.deleteSection(owner, second.id, 3)).sections.map(
          ({ title, position }) => [title, position],
        ),
      ).toEqual([["First", 0]]);
      // Tag context: membership follows the tag.
      const tag = createTag(db, owner, "T");
      const tagSection = defined(
        applied(
          db.boards.createSection(
            owner,
            { contextKind: "tag", contextId: tag, title: "Tagged" },
            uuid,
            now,
          ),
        ).sections[0],
      );
      expect(db.setTaskTags(owner, b.id, [tag], 3, later)).toBe(true);
      expect(
        db.boards.updateSection(
          owner,
          tagSection.id,
          1,
          { taskIds: [b.id] },
          later,
        ).kind,
      ).toBe("applied");
      expect(db.setTaskTags(owner, b.id, [], 4, later)).toBe(true);
      expect(db.boards.getSection(owner, tagSection.id)?.taskIds).toEqual([]);
    });
  });
});

describe("task views and menu folders", () => {
  it("saves one view per context with revisions", async () => {
    await withDatabase((db) => {
      const project = createProject(db, owner, "P");
      expect(db.boards.getTaskView(owner, "all", "")).toMatchObject({
        revision: 0,
        sortBy: null,
      });
      expect(
        db.boards.setTaskView(
          owner,
          {
            contextKind: "project",
            contextId: uuid(),
            expectedRevision: 0,
            sortBy: "name",
            sortDir: "asc",
            groupBy: null,
            filter: null,
            collapsedGroups: [],
          },
          now,
        ).kind,
      ).toBe("invalid");
      const saved = applied(
        db.boards.setTaskView(
          owner,
          {
            contextKind: "project",
            contextId: project,
            expectedRevision: 0,
            sortBy: "deadline",
            sortDir: "desc",
            groupBy: "tag",
            filter: { kind: "scheduledDate", preset: "thisWeek" },
            collapsedGroups: ["none"],
          },
          now,
        ),
      ).view;
      expect(saved).toMatchObject({
        revision: 1,
        sortBy: "deadline",
        groupBy: "tag",
      });
      expect(
        db.boards.setTaskView(owner, { ...saved, expectedRevision: 0 }, later)
          .kind,
      ).toBe("conflict");
      expect(
        applied(
          db.boards.setTaskView(
            owner,
            { ...saved, expectedRevision: 1, sortBy: null },
            later,
          ),
        ).view,
      ).toMatchObject({
        revision: 2,
        sortBy: null,
        filter: { kind: "scheduledDate", preset: "thisWeek" },
      });
      expect(db.boards.listTaskViews(other)).toEqual([]);
      expect(db.boards.listTaskViews(owner)).toHaveLength(1);
    });
  });

  it("nests folders, keeps an item in one folder and rejects cycles", async () => {
    await withDatabase((db) => {
      const p1 = createProject(db, owner, "One");
      const p2 = createProject(db, owner, "Two");
      const root = defined(
        applied(
          db.boards.createMenuFolder(
            owner,
            { kind: "project", title: "Work", itemIds: [p1, p2] },
            uuid,
            now,
          ),
        ).folders[0],
      );
      const child = defined(
        applied(
          db.boards.createMenuFolder(
            owner,
            {
              kind: "project",
              parentId: root.id,
              title: "Inner",
              itemIds: [p2],
            },
            uuid,
            now,
          ),
        ).folders.find(({ title }) => title === "Inner"),
      );
      expect(child.parentId).toBe(root.id);
      expect(db.boards.getMenuFolder(owner, root.id)).toMatchObject({
        itemIds: [p1],
        revision: 2,
      });
      expect(
        db.boards.createMenuFolder(
          owner,
          { kind: "tag", parentId: root.id, title: "X", itemIds: [] },
          uuid,
          now,
        ).kind,
      ).toBe("invalid");
      expect(
        db.boards.createMenuFolder(
          owner,
          { kind: "project", title: "X", itemIds: [uuid()] },
          uuid,
          now,
        ).kind,
      ).toBe("invalid");
      expect(
        db.boards.updateMenuFolder(
          owner,
          root.id,
          2,
          { parentId: child.id },
          later,
        ).kind,
      ).toBe("invalid");
      expect(
        db.boards.updateMenuFolder(
          owner,
          child.id,
          1,
          { parentId: null, title: "Top" },
          later,
        ).kind,
      ).toBe("applied");
      expect(
        db.boards
          .listMenuFolders(owner)
          .map(({ title, parentId, position }) => [title, parentId, position]),
      ).toEqual([
        ["Work", null, 0],
        ["Top", null, 1],
      ]);
      expect(
        db.boards.reorderMenuFolders(
          owner,
          "project",
          null,
          [
            { id: child.id, revision: 2 },
            { id: root.id, revision: 2 },
          ],
          later,
        ).kind,
      ).toBe("applied");
      expect(
        db.boards.listMenuFolders(owner).map(({ title }) => title),
      ).toEqual(["Top", "Work"]);
      expect(
        applied(db.boards.deleteMenuFolder(owner, root.id, 3)).folders.map(
          ({ title }) => title,
        ),
      ).toEqual(["Top"]);
      expect(db.boards.listMenuFolders(other)).toEqual([]);
    });
  });
});

const importData = (): ImportedBoardData => ({
  boards: [
    {
      sourceId: "KANBAN",
      sourceJson: JSON.stringify({ id: "KANBAN", title: "Kanban" }),
      title: "Kanban",
      columns: 3,
      panels: [
        {
          sourceId: "TODO",
          title: "To do",
          filter: {
            includedTagIds: [],
            includedTagsMatch: "all",
            excludedTagIds: [],
            excludedTagsMatch: "any",
            includedMarkers: [],
            excludedMarkers: ["in_progress"],
            projectIds: [],
            doneState: "open",
            scheduledState: "all",
            backlogState: "all",
            parentsOnly: false,
            sortBy: null,
            sortDir: "asc",
          },
          sourceTaskIds: ["t2", "t1", "missing"],
        },
      ],
    },
  ],
  sections: [
    {
      sourceId: "s1",
      sourceJson: JSON.stringify({ id: "s1" }),
      contextKind: "project",
      sourceContextId: "p",
      title: "Now",
      expanded: true,
      sourceTaskIds: ["t1"],
    },
  ],
  folders: [
    {
      sourceId: "f1",
      sourceJson: JSON.stringify({ id: "f1", name: "Work" }),
      kind: "project",
      sourceParentId: null,
      title: "Work",
      expanded: false,
      sourceItemIds: ["p"],
    },
    {
      sourceId: "f2",
      sourceJson: JSON.stringify({ id: "f2", name: "Inner" }),
      kind: "project",
      sourceParentId: "f1",
      title: "Inner",
      expanded: true,
      sourceItemIds: [],
    },
  ],
  taskMarkers: [{ sourceTaskId: "t2", markers: ["in_progress"] }],
});

const record = (
  kind: "project" | "task",
  sourceId: string,
  title: string,
  projectId: string | null = null,
) => ({
  kind,
  sourceId,
  sourceJson: JSON.stringify({ id: sourceId, title }),
  sourceHash: `${sourceId}-hash`,
  title,
  notes: "",
  projectId,
  tagIds: [],
  plannedStart: null,
  plannedDay: null,
  deadlineDate: null,
  deadlineAt: null,
  estimateMinutes: null,
  completedAt: null,
  createdAt: now,
  startReminder: { kind: "default" as const },
  deadlineReminderMinutes: null,
  parentSourceId: null,
  childIndex: null,
});

describe("import", () => {
  it("imports boards, sections, folders and markers once and survives restart and backup", async () => {
    await withTemporaryDirectory((directory) => {
      const path = join(directory, "suite.sqlite");
      let db = open(path);
      const records = [
        record("project", "p", "Project"),
        record("task", "t1", "One", "p"),
        record("task", "t2", "Two", "p"),
      ];
      const first = db.importTaskRecords(owner, records, now, undefined, {
        boards: importData(),
      });
      expect(first.boards).toEqual({
        boards: 1,
        sections: 1,
        folders: 2,
        existing: 0,
      });
      const board = defined(db.boards.listBoards(owner)[0]);
      const view = defined(db.boards.viewBoard(owner, board.id, clock));
      const tasks = db.listTasks(owner);
      const t1 = defined(tasks.find(({ title }) => title === "One"));
      const t2 = defined(tasks.find(({ title }) => title === "Two"));
      // t2 carries the in_progress marker, so the panel excludes it; t1 is the only member.
      expect(view.members[0]?.taskIds).toEqual([t1.id]);
      expect(db.boards.markersOf(owner, t2.id)).toEqual(["in_progress"]);
      expect(t2.tagIds).toEqual([]);
      const project = defined(db.listProjects(owner)[0]);
      expect(
        db.boards.listSections(owner, {
          contextKind: "project",
          contextId: project.id,
        }),
      ).toEqual([expect.objectContaining({ title: "Now", taskIds: [t1.id] })]);
      const folders = db.boards.listMenuFolders(owner);
      expect(
        folders.map(({ title, parentId, itemIds }) => [
          title,
          parentId === null,
          itemIds,
        ]),
      ).toEqual([
        ["Work", true, [project.id]],
        ["Inner", false, []],
      ]);

      // A repeated import changes nothing; a changed source fails the import.
      const again = db.importTaskRecords(owner, records, now, undefined, {
        boards: importData(),
      });
      expect(again.boards).toEqual({
        boards: 0,
        sections: 0,
        folders: 0,
        existing: 4,
      });
      expect(db.boards.listBoards(owner)).toHaveLength(1);
      expect(db.boards.listMenuFolders(owner)).toHaveLength(2);
      const changed = importData();
      expect(() =>
        db.importTaskRecords(owner, records, now, undefined, {
          boards: {
            ...changed,
            boards: [
              {
                ...defined(changed.boards[0]),
                sourceJson: JSON.stringify({ id: "KANBAN", title: "Other" }),
              },
            ],
          },
        }),
      ).toThrow("IMPORT_SOURCE_CHANGED");
      expect(db.boards.listBoards(owner)).toHaveLength(1);

      db.close();
      db = open(path);
      expect(
        db.boards.viewBoard(owner, board.id, clock)?.members[0]?.taskIds,
      ).toEqual([t1.id]);
      mkdirSync(join(directory, "backup"));
      db.backup(join(directory, "backup", "suite.sqlite"));
      db.close();
      const restored = SuiteDatabase.open(
        join(directory, "backup", "suite.sqlite"),
      );
      try {
        expect(restored.boards.listBoards(owner)).toEqual([board]);
        expect(restored.boards.listMenuFolders(owner)).toEqual(folders);
        expect(restored.boards.markersOf(owner, t2.id)).toEqual([
          "in_progress",
        ]);
        expect(restored.state().appliedMigrationCount).toBe(35);
      } finally {
        restored.close();
      }
    });
  });
});
