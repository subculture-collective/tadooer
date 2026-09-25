import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  automationConfirmationResponseSchema,
  automationPreviewResponseSchema,
  automationTokenScopeSchema,
  clientRegistrationResponseSchema,
  createAutomationTokenResponseSchema,
  superProductivityPreviewSchema,
  syncRoundResponseSchema,
  syncSnapshotResponseSchema,
  taskArchiveMutationResponseSchema,
  taskHistoryResponseSchema,
  taskListResponseSchema,
  taskMutationResponseSchema,
} from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer, type RunningSuiteServer } from "./server.ts";

// Archived task history over HTTP, sync and the assistant (issue #38, ADR 0022).
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

const signIn = async (server: RunningSuiteServer) => {
  const owner = {
    username: "history",
    displayName: "History",
    password: "a sufficiently long disposable password",
  };
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
    method: "GET" | "POST" | "PATCH",
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

const createTask = async (call: Call, title: string, parentId?: string) =>
  taskMutationResponseSchema.parse(
    await (
      await call(
        parentId === undefined
          ? "/api/tasks"
          : `/api/tasks/${parentId}/children`,
        "POST",
        { title },
        { "Idempotency-Key": randomUUID() },
      )
    ).json(),
  ).task;

const history = async (call: Call, query = "") =>
  taskHistoryResponseSchema.parse(
    await (
      await call(
        `/api/tasks/history${query === "" ? "" : `?query=${encodeURIComponent(query)}`}`,
        "GET",
      )
    ).json(),
  );

it("archives, searches and restores task families over HTTP, removes them from sync and survives restart", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    let server = await startSuiteServer(configuration(directory));
    try {
      let call = await signIn(server);
      const client = clientRegistrationResponseSchema.parse(
        await (await call("/api/clients", "POST", { label: "Laptop" })).json(),
      );
      const proof = {
        "X-Suite-Client-Id": client.client.id,
        "X-Suite-Client-Credential": client.clientCredential,
        "X-Suite-Sync-Version": "2",
      };
      const round = async (cursor: unknown, operations: unknown[] = []) => {
        const response = await call(
          "/api/sync/round",
          "POST",
          { cursor, operations, pullLimit: 100 },
          proof,
        );
        expect(response.status).toBe(200);
        return syncRoundResponseSchema.parse(await response.json());
      };
      const parent = await createTask(call, "Quarterly report");
      const child = await createTask(call, "Collect numbers", parent.id);
      const kept = await createTask(call, "Water plants");
      const before = await round(null);
      const cursor = before.nextCursor;

      const archive = (id: string, revision: number) =>
        call(
          `/api/tasks/${id}/archive`,
          "POST",
          {},
          {
            "If-Match": `"${String(revision)}"`,
          },
        );
      expect((await archive(parent.id, parent.revision + 5)).status).toBe(412);
      const childArchive = await archive(child.id, child.revision);
      expect(childArchive.status).toBe(409);
      expect(await childArchive.json()).toMatchObject({
        code: "TASK_ARCHIVE_CHILD",
      });
      const parentRevision =
        taskListResponseSchema
          .parse(await (await call("/api/tasks", "GET")).json())
          .tasks.find(({ id }) => id === parent.id)?.revision ?? 0;
      const archived = await archive(parent.id, parentRevision);
      expect(archived.status).toBe(200);
      const body = taskArchiveMutationResponseSchema.parse(
        await archived.json(),
      );
      expect(body.archive).toMatchObject({
        action: "archived",
        task: { id: parent.id, archivedAt: expect.any(String) as string },
        children: [{ id: child.id }],
      });

      // Active lists, the offline change feed and snapshots drop the family.
      const active = taskListResponseSchema.parse(
        await (await call("/api/tasks", "GET")).json(),
      );
      expect(active.tasks.map(({ id }) => id)).toEqual([kept.id]);
      const changes = await round(cursor);
      const removed = changes.changes.filter(({ entityId }) =>
        [parent.id, child.id].includes(entityId),
      );
      expect(removed.map(({ kind, snapshot }) => [kind, snapshot])).toEqual([
        ["deleted", null],
        ["deleted", null],
      ]);
      const snapshot = syncSnapshotResponseSchema.parse(
        await (
          await call("/api/sync/snapshot", "GET", undefined, proof)
        ).json(),
      );
      expect(
        snapshot.snapshots.flatMap((entry) =>
          entry.entityKind === "task" ? [entry.value.task.id] : [],
        ),
      ).toEqual([kept.id]);
      // An offline edit queued before the archive becomes a visible conflict.
      const conflict = await round(changes.nextCursor, [
        {
          operationId: randomUUID(),
          clientSequence: 1,
          createdAt: new Date().toISOString(),
          requestHash: "a".repeat(43),
          kind: "task.patch",
          taskId: child.id,
          fields: { title: "Edited offline" },
          baseFieldVersions: { title: 1 },
        },
      ]);
      expect(conflict.outcomes[0]).toMatchObject({
        kind: "conflict",
        code: "SYNC_RESOURCE_CONFLICT",
        taskId: child.id,
      });
      // Archived tasks are not editable through the active task API.
      expect(
        (
          await call(
            `/api/tasks/${parent.id}`,
            "PATCH",
            { title: "Changed" },
            { "If-Match": `"${String(body.archive.task.revision)}"` },
          )
        ).status,
      ).toBe(404);

      expect((await history(call)).entries[0]).toMatchObject({
        task: { id: parent.id, title: "Quarterly report" },
        provenance: null,
        children: [{ task: { id: child.id } }],
      });
      expect((await history(call, "numbers")).total).toBe(1);
      expect((await history(call, "plants")).total).toBe(0);
      expect(
        (await call("/api/tasks/history?cursor=not!valid", "GET")).status,
      ).toBe(400);

      await server.close();
      server = await startSuiteServer(configuration(directory));
      call = await signIn(server);
      expect((await history(call)).total).toBe(1);
      const restore = await call(
        `/api/tasks/${parent.id}/unarchive`,
        "POST",
        {},
        { "If-Match": `"${String(body.archive.task.revision)}"` },
      );
      expect(restore.status).toBe(200);
      expect(
        taskArchiveMutationResponseSchema.parse(await restore.json()).archive,
      ).toMatchObject({ action: "restored", children: [{ id: child.id }] });
      const restoredTasks = taskListResponseSchema.parse(
        await (await call("/api/tasks", "GET")).json(),
      );
      expect(restoredTasks.tasks.map(({ id }) => id).toSorted()).toEqual(
        [parent.id, child.id, kept.id].toSorted(),
      );
      expect(
        restoredTasks.tasks.find(({ id }) => id === parent.id),
      ).not.toHaveProperty("archivedAt");
      expect((await history(call)).total).toBe(0);
    } finally {
      await server.close();
    }
  });
});

it("reads history and archives or restores through assistant previews with frozen revisions", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const server = await startSuiteServer(configuration(directory));
    try {
      const call = await signIn(server);
      const token = createAutomationTokenResponseSchema.parse(
        await (
          await call("/api/automation/tokens", "POST", {
            label: "Assistant",
            scopes: [...automationTokenScopeSchema.options],
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
          })
        ).json(),
      ).token;
      const automation = async (
        path: string,
        body?: unknown,
      ): Promise<{ status: number; body: unknown }> => {
        const response = await fetch(`${server.baseUrl}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, body: await response.json() };
      };
      const preview = (operation: string, input: unknown) =>
        automation("/api/automation/v1/previews", { operation, input });
      const confirm = (previewId: string) =>
        automation(`/api/automation/v1/previews/${previewId}/confirm`, {
          idempotencyKey: randomUUID(),
        });
      const parent = await createTask(call, "Plan trip");
      const child = await createTask(call, "Book train", parent.id);
      const revisionOf = async (id: string) =>
        taskListResponseSchema
          .parse(await (await call("/api/tasks", "GET")).json())
          .tasks.find((task) => task.id === id)?.revision ?? 0;

      const archivePreview = await preview("tasks.archive", {
        taskId: parent.id,
        expectedRevision: await revisionOf(parent.id),
      });
      expect(archivePreview.status).toBe(201);
      const frozen = automationPreviewResponseSchema.parse(
        archivePreview.body,
      ).preview;
      expect(frozen.summary).toContain(
        'Archive task "Plan trip" with 1 child task',
      );
      expect(
        frozen.affected.map(({ entityId }) => entityId).toSorted(),
      ).toEqual([parent.id, child.id].toSorted());
      // A child changed after preview makes the confirmation stale.
      await call(
        `/api/tasks/${child.id}`,
        "PATCH",
        { title: "Book train tickets" },
        { "If-Match": `"${String(await revisionOf(child.id))}"` },
      );
      expect((await confirm(frozen.id)).status).toBe(412);

      const fresh = automationPreviewResponseSchema.parse(
        (
          await preview("tasks.archive", {
            taskId: parent.id,
            expectedRevision: await revisionOf(parent.id),
          })
        ).body,
      ).preview;
      const confirmed = await confirm(fresh.id);
      expect(confirmed.status).toBe(200);
      const result = automationConfirmationResponseSchema.parse(
        confirmed.body,
      ).result;
      if (!("archive" in result)) throw new Error("Expected archive result");
      expect(result.archive.children.map(({ title }) => title)).toEqual([
        "Book train tickets",
      ]);

      const resource = await automation(
        "/api/automation/v1/resources/tasks/history?query=trip&limit=5",
      );
      expect(resource.status).toBe(200);
      expect(taskHistoryResponseSchema.parse(resource.body)).toMatchObject({
        total: 1,
        entries: [{ task: { id: parent.id } }],
      });
      expect(
        await preview("tasks.archive", {
          taskId: parent.id,
          expectedRevision: result.archive.task.revision,
        }),
      ).toMatchObject({ status: 404 });
      expect(
        await preview("tasks.unarchive", {
          taskId: child.id,
          expectedRevision: result.archive.children[0]?.revision,
        }),
      ).toMatchObject({ status: 409, body: { code: "TASK_ARCHIVE_CHILD" } });
      const unarchive = automationPreviewResponseSchema.parse(
        (
          await preview("tasks.unarchive", {
            taskId: parent.id,
            expectedRevision: result.archive.task.revision,
          })
        ).body,
      ).preview;
      expect(unarchive.summary).toContain('Restore archived task "Plan trip"');
      expect((await confirm(unarchive.id)).status).toBe(200);
      expect(await revisionOf(parent.id)).toBeGreaterThan(
        result.archive.task.revision,
      );
    } finally {
      await server.close();
    }
  });
});

it("imports archived Super Productivity history with review flags and historical references", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const server = await startSuiteServer(configuration(directory));
    try {
      const call = await signIn(server);
      const state = (entities: Record<string, unknown>) => ({
        ids: Object.keys(entities),
        entities,
      });
      const done = {
        isDone: true,
        doneOn: 1700000060000,
        created: 1700000000000,
      };
      const exported = {
        task: state({ live: { id: "live", title: "Live task" } }),
        project: state({ p: { id: "p", title: "Project" } }),
        archiveYoung: {
          task: state({
            parent: {
              id: "parent",
              title: "Archived parent",
              subTaskIds: ["blank"],
              projectId: "p",
              ...done,
            },
            blank: { id: "blank", title: "", parentId: "parent", ...done },
          }),
          timeTracking: { project: {}, tag: {} },
        },
        archiveOld: {
          task: state({
            old: {
              id: "old",
              title: "Old task",
              projectId: "deleted-project",
              tagIds: ["deleted-tag"],
              ...done,
            },
          }),
        },
      };
      const preview = superProductivityPreviewSchema.parse(
        await (
          await call(
            "/api/imports/super-productivity/preview",
            "POST",
            exported,
          )
        ).json(),
      );
      expect(preview.canApply).toBe(true);
      expect(preview.totals.archived).toBe(3);
      expect(
        preview.issues.filter(({ blocking }) => blocking === true),
      ).toEqual([]);
      const apply = () =>
        call("/api/imports/super-productivity/apply", "POST", exported, {
          "X-Import-Hash": preview.inputHash,
        });
      const applied = await apply();
      expect(applied.status).toBe(200);
      expect(await applied.json()).toEqual({ created: 5, existing: 0 });
      expect(await (await apply()).json()).toEqual({ created: 0, existing: 5 });

      const active = taskListResponseSchema.parse(
        await (await call("/api/tasks", "GET")).json(),
      );
      expect(active.tasks.map(({ title }) => title)).toEqual(["Live task"]);
      const imported = await history(call);
      expect(imported.total).toBe(2);
      const byTitle = new Map(
        imported.entries.map((entry) => [entry.task.title, entry]),
      );
      expect(byTitle.get("Archived parent")).toMatchObject({
        task: {
          createdAt: new Date(1700000000000).toISOString(),
          completedAt: new Date(1700000060000).toISOString(),
        },
        provenance: { sourceStore: "archiveYoung", review: [] },
        children: [
          {
            task: { title: "Untitled archived task" },
            provenance: { review: ["blank_title"] },
          },
        ],
      });
      expect(byTitle.get("Archived parent")?.task.projectId).toEqual(
        expect.any(String),
      );
      expect(byTitle.get("Old task")).toMatchObject({
        task: { projectId: null, tagIds: [] },
        provenance: {
          sourceStore: "archiveOld",
          historicalReferences: [
            {
              kind: "project",
              sourceId: "deleted-project",
              reason: "missing_from_export",
            },
            {
              kind: "tag",
              sourceId: "deleted-tag",
              reason: "missing_from_export",
            },
          ],
        },
      });
    } finally {
      await server.close();
    }
  });
});
