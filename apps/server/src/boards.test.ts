import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  automationConfirmationResponseSchema,
  automationPreviewResponseSchema,
  automationTokenScopeSchema,
  boardListResponseSchema,
  boardMoveResponseSchema,
  boardResponseSchema,
  boardViewResponseSchema,
  createAutomationTokenResponseSchema,
  menuFolderListResponseSchema,
  sectionListResponseSchema,
  superProductivityPreviewSchema,
  tagSchema,
  taskImportApplyResponseSchema,
  taskMutationResponseSchema,
  taskViewResponseSchema,
} from "@suite/contracts";
import { ManualSessionClock } from "@suite/domain";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer, type RunningSuiteServer } from "./server.ts";

// Boards, sections, saved views and folders over HTTP, the assistant and the
// importer (#63, ADR 0028).
const configuration = (directory: string): ServerConfig => ({
  host: "127.0.0.1",
  port: 0,
  databasePath: join(directory, "suite.sqlite"),
  webRoot: join(directory, "web"),
  baikalEndpoint: "http://baikal.test/dav.php/",
  credentialKeyPath: join(directory, "credential.key"),
  secureCookies: false,
  build: { version: "test", revision: "test", builtAt: null },
});

const owner = {
  username: "boarder",
  displayName: "Boarder",
  password: "a sufficiently long disposable password",
};

const signIn = async (server: RunningSuiteServer, setup: boolean) => {
  if (setup)
    await fetch(`${server.baseUrl}/api/setup`, {
      method: "POST",
      headers: { Origin: server.baseUrl, "Content-Type": "application/json" },
      body: JSON.stringify(owner),
    });
  const login = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { Origin: server.baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify(owner),
  });
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  return (
    path: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${server.baseUrl}${path}`, {
      method,
      headers: {
        Origin: server.baseUrl,
        Cookie: cookie,
        "X-CSRF-Token": csrfToken,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
};
type Call = Awaited<ReturnType<typeof signIn>>;

const createTask = async (call: Call, title: string) =>
  taskMutationResponseSchema.parse(
    await (
      await call(
        "/api/tasks",
        "POST",
        { title },
        { "Idempotency-Key": randomUUID() },
      )
    ).json(),
  ).task;

const json = async (response: Response) => ({
  status: response.status,
  body: (await response.json()) as unknown,
});

it("serves boards, sections, views and folders with revisions and explicit moves", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const config = configuration(directory);
    let server = await startSuiteServer(config);
    try {
      let call = await signIn(server, true);
      const tag = tagSchema.parse(
        (
          (await (
            await call("/api/tags", "POST", { title: "Deep" })
          ).json()) as { tag: unknown }
        ).tag,
      );
      const a = await createTask(call, "Alpha");
      const b = await createTask(call, "Beta");

      // Templates are created on demand, never automatically.
      expect(
        boardListResponseSchema.parse(
          await (await call("/api/boards", "GET")).json(),
        ),
      ).toEqual({ boards: [] });
      const kanban = boardResponseSchema.parse(
        await (
          await call("/api/boards", "POST", { template: "kanban" })
        ).json(),
      ).board;
      expect(kanban.panels.map(({ title }) => title)).toEqual([
        "To do",
        "In progress",
        "Done",
      ]);
      const [todo, doing] = kanban.panels.map(({ id }) => id) as [
        string,
        string,
        string,
      ];
      const view = boardViewResponseSchema.parse(
        await (await call(`/api/boards/${kanban.id}`, "GET")).json(),
      ).view;
      expect(view.members[0]).toEqual({ panelId: todo, taskIds: [a.id, b.id] });

      // A dry run lists the changes; the move applies them and returns the view.
      const movePath = `/api/boards/${kanban.id}/panels/${doing}/tasks`;
      const dry = boardMoveResponseSchema.parse(
        await (
          await call(movePath, "POST", {
            expectedRevision: kanban.revision,
            taskId: a.id,
            taskRevision: a.revision,
            dryRun: true,
          })
        ).json(),
      );
      expect(dry).toEqual({
        applied: false,
        changes: [{ kind: "add_marker", marker: "in_progress" }],
      });
      const stale = await call(movePath, "POST", {
        expectedRevision: kanban.revision + 1,
        taskId: a.id,
        taskRevision: a.revision,
      });
      expect(stale.status).toBe(412);
      expect(await stale.json()).toMatchObject({
        code: "BOARD_REVISION_CONFLICT",
      });
      expect(
        (
          await call(movePath, "POST", {
            expectedRevision: kanban.revision,
            taskId: a.id,
            taskRevision: a.revision + 1,
          })
        ).status,
      ).toBe(412);
      const moved = boardMoveResponseSchema.parse(
        await (
          await call(movePath, "POST", {
            expectedRevision: kanban.revision,
            taskId: a.id,
            taskRevision: a.revision,
          })
        ).json(),
      );
      expect(moved.applied).toBe(true);
      expect(moved.view?.members[1]).toEqual({
        panelId: doing,
        taskIds: [a.id],
      });
      expect(moved.view?.markers[a.id]).toEqual(["in_progress"]);
      // Markers are not tags: the task's tags are unchanged.
      const listed = (await (await call("/api/tasks", "GET")).json()) as {
        tasks: { id: string; tagIds?: string[] }[];
      };
      expect(listed.tasks.find(({ id }) => id === a.id)?.tagIds).toEqual([]);

      // Editing replaces the configuration; a stale revision fails.
      const edit = (expectedRevision: number) =>
        call(`/api/boards/${kanban.id}`, "PUT", {
          expectedRevision,
          title: "Flow",
          columns: 2,
          panels: [
            {
              id: todo,
              title: "Next",
              filter: { doneState: "open", includedTagIds: [tag.id] },
            },
            { title: "Later" },
          ],
        });
      expect((await edit(1)).status).toBe(412);
      const edited = boardResponseSchema.parse(
        await (await edit(2)).json(),
      ).board;
      expect(edited).toMatchObject({ title: "Flow", columns: 2, revision: 3 });
      expect(
        edited.panels.map(({ id, title }) => [id === todo, title]),
      ).toEqual([
        [true, "Next"],
        [false, "Later"],
      ]);
      expect(
        (
          await call(`/api/boards/${kanban.id}`, "PUT", {
            expectedRevision: 3,
            title: "Flow",
            columns: 2,
            panels: [
              { title: "Bad", filter: { includedTagIds: [randomUUID()] } },
            ],
          })
        ).status,
      ).toBe(400);
      // Writes need the CSRF token.
      expect(
        (
          await call(
            `/api/boards`,
            "POST",
            { template: "kanban" },
            { "X-CSRF-Token": "wrong" },
          )
        ).status,
      ).toBe(403);

      // Sections inside the tag context.
      await call(
        `/api/tasks/${b.id}/tags`,
        "PUT",
        { tagIds: [tag.id] },
        {
          "If-Match": `"${String(b.revision)}"`,
        },
      );
      const sections = sectionListResponseSchema.parse(
        await (
          await call("/api/sections", "POST", {
            contextKind: "tag",
            contextId: tag.id,
            title: "Now",
          })
        ).json(),
      ).sections;
      const section = sections[0];
      if (section === undefined) throw new Error("section missing");
      expect(
        (
          await call(`/api/sections/${section.id}`, "PUT", {
            expectedRevision: 1,
            taskIds: [a.id],
          })
        ).status,
      ).toBe(400);
      const placed = sectionListResponseSchema.parse(
        await (
          await call(`/api/sections/${section.id}`, "PUT", {
            expectedRevision: 1,
            taskIds: [b.id],
            expanded: false,
          })
        ).json(),
      ).sections[0];
      expect(placed).toMatchObject({
        taskIds: [b.id],
        expanded: false,
        revision: 2,
      });
      expect(
        (
          await call(`/api/sections/${section.id}`, "PUT", {
            expectedRevision: 1,
            title: "Old",
          })
        ).status,
      ).toBe(412);
      expect(
        (await call(`/api/sections?contextKind=tag&contextId=${tag.id}`, "GET"))
          .status,
      ).toBe(200);
      expect((await call("/api/sections?contextKind=list", "GET")).status).toBe(
        400,
      );
      expect(
        (
          await call(`/api/sections/${section.id}`, "DELETE", undefined, {
            "If-Match": '"1"',
          })
        ).status,
      ).toBe(412);

      // Saved views per context.
      const saved = taskViewResponseSchema.parse(
        await (
          await call("/api/task-views", "PUT", {
            contextKind: "tag",
            contextId: tag.id,
            expectedRevision: 0,
            sortBy: "name",
            groupBy: "project",
          })
        ).json(),
      ).view;
      expect(saved).toMatchObject({
        revision: 1,
        sortBy: "name",
        sortDir: "asc",
        filter: null,
      });
      expect(
        (
          await call("/api/task-views", "PUT", {
            contextKind: "tag",
            contextId: tag.id,
            expectedRevision: 0,
            sortBy: "deadline",
          })
        ).status,
      ).toBe(412);
      expect(
        (
          await call("/api/task-views", "PUT", {
            contextKind: "all",
            contextId: tag.id,
            expectedRevision: 0,
          })
        ).status,
      ).toBe(400);

      // Folders nest and hold each item once.
      const folders = menuFolderListResponseSchema.parse(
        await (
          await call("/api/menu-folders", "POST", {
            kind: "tag",
            title: "Work",
            itemIds: [tag.id],
          })
        ).json(),
      ).folders;
      const work = folders[0];
      if (work === undefined) throw new Error("folder missing");
      const inner = menuFolderListResponseSchema
        .parse(
          await (
            await call("/api/menu-folders", "POST", {
              kind: "tag",
              parentId: work.id,
              title: "Inner",
              itemIds: [tag.id],
            })
          ).json(),
        )
        .folders.find(({ title }) => title === "Inner");
      expect(inner).toMatchObject({ parentId: work.id, itemIds: [tag.id] });
      expect(
        menuFolderListResponseSchema
          .parse(await (await call("/api/menu-folders", "GET")).json())
          .folders.map(({ title, itemIds }) => [title, itemIds]),
      ).toEqual([
        ["Work", []],
        ["Inner", [tag.id]],
      ]);
      expect(
        (
          await call(`/api/menu-folders/${work.id}`, "PUT", {
            expectedRevision: 2,
            parentId: inner?.id,
          })
        ).status,
      ).toBe(400);

      // Everything survives a restart.
      await server.close();
      server = await startSuiteServer(config);
      call = await signIn(server, false);
      expect(
        boardListResponseSchema
          .parse(await (await call("/api/boards", "GET")).json())
          .boards.map(({ title, revision }) => [title, revision]),
      ).toEqual([["Flow", 3]]);
      expect(
        (
          await call(`/api/boards/${kanban.id}`, "DELETE", undefined, {
            "If-Match": '"3"',
          })
        ).status,
      ).toBe(204);
      expect((await call(`/api/boards/${kanban.id}`, "GET")).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});

it("lets the assistant read boards and move a task with a previewed change list", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const clock = new ManualSessionClock("2026-09-25T15:00:00.000Z");
    const server = await startSuiteServer(configuration(directory), {
      sessionClock: clock,
    });
    try {
      const call = await signIn(server, true);
      const task = await createTask(call, "Alpha");
      const board = boardResponseSchema.parse(
        await (
          await call("/api/boards", "POST", { template: "eisenhower" })
        ).json(),
      ).board;
      const urgentImportant = board.panels[0]?.id ?? "";
      const token = createAutomationTokenResponseSchema.parse(
        await (
          await call("/api/automation/tokens", "POST", {
            label: "Assistant",
            scopes: [...automationTokenScopeSchema.options],
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          })
        ).json(),
      ).token;
      const automation = async (path: string, body?: unknown) =>
        json(
          await fetch(`${server.baseUrl}${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              ...(body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      const listed = await automation("/api/automation/v1/resources/boards");
      expect(listed.status).toBe(200);
      expect(listed.body).toMatchObject({
        boards: [{ id: board.id }],
        views: [{ today: "2026-09-25" }],
      });
      expect(
        Array.isArray(
          (listed.body as { views: { members: unknown }[] }).views[0]?.members,
        ),
      ).toBe(true);
      expect(
        (await automation("/api/automation/v1/resources/task-views")).body,
      ).toEqual({
        views: [],
      });
      expect(
        (await automation("/api/automation/v1/resources/menu-folders")).body,
      ).toEqual({
        folders: [],
      });
      expect(
        (
          await automation(
            "/api/automation/v1/resources/sections?contextKind=project",
          )
        ).status,
      ).toBe(400);

      const preview = async (input: unknown) => {
        const response = await automation("/api/automation/v1/previews", {
          operation: "boards.mutate",
          input,
        });
        return response;
      };
      const stale = await preview({
        action: "move_task",
        boardId: board.id,
        panelId: urgentImportant,
        move: {
          expectedRevision: 9,
          taskId: task.id,
          taskRevision: task.revision,
        },
      });
      expect(stale.status).toBe(412);
      const planned = await preview({
        action: "move_task",
        boardId: board.id,
        panelId: urgentImportant,
        move: {
          expectedRevision: board.revision,
          taskId: task.id,
          taskRevision: task.revision,
        },
      });
      expect(planned.status).toBe(201);
      const parsedPreview = automationPreviewResponseSchema.parse(
        planned.body,
      ).preview;
      expect(parsedPreview.summary).toBe(
        'Move task "Alpha" into panel "Urgent and important" of board "Eisenhower matrix": mark important, mark urgent',
      );
      expect(parsedPreview.baseRevisions).toEqual(
        expect.arrayContaining([
          { entityKind: "board", entityId: board.id, revision: 1 },
          { entityKind: "task", entityId: task.id, revision: task.revision },
        ]),
      );
      // A browser edit between preview and confirmation makes it stale.
      expect(
        (
          await call(`/api/boards/${board.id}`, "PUT", {
            expectedRevision: 1,
            title: "Matrix",
            columns: 2,
            panels: board.panels.map(({ id, title, filter }) => ({
              id,
              title,
              filter,
            })),
          })
        ).status,
      ).toBe(200);
      const staleConfirm = await automation(
        `/api/automation/v1/previews/${parsedPreview.id}/confirm`,
        { idempotencyKey: randomUUID() },
      );
      expect(staleConfirm.status).toBe(412);

      const fresh = automationPreviewResponseSchema.parse(
        (
          await preview({
            action: "move_task",
            boardId: board.id,
            panelId: urgentImportant,
            move: {
              expectedRevision: 2,
              taskId: task.id,
              taskRevision: task.revision,
            },
          })
        ).body,
      ).preview;
      const key = randomUUID();
      const confirmed = await automation(
        `/api/automation/v1/previews/${fresh.id}/confirm`,
        {
          idempotencyKey: key,
        },
      );
      expect(confirmed.status).toBe(200);
      const result = automationConfirmationResponseSchema.parse(
        confirmed.body,
      ).result;
      expect(result).toMatchObject({
        changes: [
          { kind: "add_marker", marker: "important" },
          { kind: "add_marker", marker: "urgent" },
        ],
      });
      expect("changes" in result ? result.view?.members[0] : undefined).toEqual(
        {
          panelId: urgentImportant,
          taskIds: [task.id],
        },
      );
      expect(
        automationConfirmationResponseSchema.parse(
          (
            await automation(
              `/api/automation/v1/previews/${fresh.id}/confirm`,
              { idempotencyKey: key },
            )
          ).body,
        ).replayed,
      ).toBe(true);

      // Sections, views and folders through the assistant.
      const project = (
        (await (
          await call("/api/projects", "POST", { title: "P" })
        ).json()) as {
          project: { id: string };
        }
      ).project;
      const sectionPreview = automationPreviewResponseSchema.parse(
        (
          await automation("/api/automation/v1/previews", {
            operation: "sections.mutate",
            input: {
              action: "create",
              section: {
                contextKind: "project",
                contextId: project.id,
                title: "Now",
              },
            },
          })
        ).body,
      ).preview;
      const created = automationConfirmationResponseSchema.parse(
        (
          await automation(
            `/api/automation/v1/previews/${sectionPreview.id}/confirm`,
            {
              idempotencyKey: randomUUID(),
            },
          )
        ).body,
      ).result;
      expect(created).toMatchObject({
        sections: [{ title: "Now", revision: 1 }],
      });
      const viewPreview = automationPreviewResponseSchema.parse(
        (
          await automation("/api/automation/v1/previews", {
            operation: "task_views.set",
            input: {
              contextKind: "all",
              expectedRevision: 0,
              sortBy: "creationDate",
              sortDir: "desc",
            },
          })
        ).body,
      ).preview;
      expect(viewPreview.summary).toBe(
        "Save the all view: sort creationDate desc, group none, filter none",
      );
      const folderPreview = automationPreviewResponseSchema.parse(
        (
          await automation("/api/automation/v1/previews", {
            operation: "menu_folders.mutate",
            input: {
              action: "create",
              folder: { kind: "project", title: "Work", itemIds: [project.id] },
            },
          })
        ).body,
      ).preview;
      expect(
        automationConfirmationResponseSchema.parse(
          (
            await automation(
              `/api/automation/v1/previews/${folderPreview.id}/confirm`,
              {
                idempotencyKey: randomUUID(),
              },
            )
          ).body,
        ).result,
      ).toMatchObject({ folders: [{ title: "Work", itemIds: [project.id] }] });
    } finally {
      await server.close();
    }
  });
});

it("imports Super Productivity boards, sections and folders once", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const server = await startSuiteServer(configuration(directory));
    try {
      const call = await signIn(server, true);
      const state = (entities: Record<string, unknown>) => ({
        ids: Object.keys(entities),
        entities,
      });
      const created = 1758000000000;
      const panel = (id: string, extra: Record<string, unknown>) => ({
        id,
        title: id,
        includedTagIds: [],
        excludedTagIds: [],
        taskIds: [],
        taskDoneState: 1,
        scheduledState: 1,
        backlogState: 1,
        isParentTasksOnly: false,
        projectIds: [""],
        ...extra,
      });
      const source = {
        project: state({ p: { id: "p", title: "P", created } }),
        tag: state({
          EM_URGENT: { id: "EM_URGENT", title: "urgent" },
          TODAY: { id: "TODAY", title: "Today", taskIds: [] },
        }),
        task: state({
          t1: {
            id: "t1",
            title: "One",
            projectId: "p",
            tagIds: ["EM_URGENT"],
            created,
          },
          t2: { id: "t2", title: "Two", projectId: "p", tagIds: [], created },
        }),
        boards: {
          boardCfgs: [
            {
              id: "M",
              title: "Matrix",
              cols: 2,
              panels: [
                panel("urgent", {
                  includedTagIds: ["EM_URGENT"],
                  taskIds: ["t1"],
                }),
                panel("calm", {
                  excludedTagIds: ["EM_URGENT"],
                  taskIds: ["t2"],
                }),
              ],
            },
          ],
        },
        section: state({
          s1: {
            id: "s1",
            contextId: "p",
            contextType: "PROJECT",
            title: "Now",
            taskIds: ["t2"],
          },
        }),
        menuTree: {
          projectTree: [
            {
              k: "f",
              id: "f1",
              name: "Work",
              isExpanded: true,
              children: [{ k: "p", id: "p" }],
            },
          ],
          tagTree: [],
        },
      };
      const preview = superProductivityPreviewSchema.parse(
        await (
          await call("/api/imports/super-productivity/preview", "POST", source)
        ).json(),
      );
      expect(preview.canApply).toBe(true);
      expect(
        preview.issues.filter(({ blocking }) => blocking === true),
      ).toEqual([]);
      const apply = () =>
        call("/api/imports/super-productivity/apply", "POST", source, {
          "X-Import-Hash": preview.inputHash,
        });
      const first = taskImportApplyResponseSchema.parse(
        await (await apply()).json(),
      );
      expect(first.boards).toEqual({
        boards: 1,
        sections: 1,
        folders: 1,
        existing: 0,
      });
      const boards = boardListResponseSchema.parse(
        await (await call("/api/boards", "GET")).json(),
      ).boards;
      expect(boards).toHaveLength(1);
      const board = boards[0];
      if (board === undefined) throw new Error("board missing");
      expect(board.panels[0]?.filter.includedMarkers).toEqual(["urgent"]);
      const view = boardViewResponseSchema.parse(
        await (await call(`/api/boards/${board.id}`, "GET")).json(),
      ).view;
      expect(view.members.map(({ taskIds }) => taskIds.length)).toEqual([1, 1]);
      const urgentTask = view.members[0]?.taskIds[0] ?? "";
      expect(view.markers[urgentTask]).toEqual(["urgent"]);
      const second = taskImportApplyResponseSchema.parse(
        await (await apply()).json(),
      );
      expect(second.boards).toEqual({
        boards: 0,
        sections: 0,
        folders: 0,
        existing: 3,
      });
      expect(
        boardListResponseSchema.parse(
          await (await call("/api/boards", "GET")).json(),
        ).boards,
      ).toHaveLength(1);
      expect(
        menuFolderListResponseSchema.parse(
          await (await call("/api/menu-folders", "GET")).json(),
        ).folders,
      ).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});
