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
  syncRoundResponseSchema,
  syncSnapshotResponseSchema,
  taskChildrenResponseSchema,
  taskMutationResponseSchema,
  taskSchema,
} from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer, type RunningSuiteServer } from "./server.ts";

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
    username: "hierarchy",
    displayName: "Hierarchy",
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
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
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

it("creates, moves, reorders, converts and cascades child tasks over HTTP and survives restart", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    let server = await startSuiteServer(configuration(directory));
    try {
      let call = await signIn(server);
      const createTask = async (title: string) =>
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
      const parent = await createTask("Parent");
      const other = await createTask("Other parent");
      const key = randomUUID();
      const createChild = (title: string, idempotencyKey = key) =>
        call(
          `/api/tasks/${parent.id}/children`,
          "POST",
          { title, notes: "Child notes", estimateMinutes: 30 },
          { "Idempotency-Key": idempotencyKey },
        );
      const first = await createChild("First child");
      expect(first.status).toBe(201);
      const child = taskMutationResponseSchema.parse(await first.json()).task;
      expect(child).toMatchObject({
        parentId: parent.id,
        notes: "Child notes",
        estimateMinutes: 30,
      });
      const replay = await createChild("First child");
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({
        replayed: true,
        task: { id: child.id },
      });
      expect((await createChild("Different")).status).toBe(409);
      const second = taskMutationResponseSchema.parse(
        await (await createChild("Second child", randomUUID())).json(),
      ).task;
      // Children cannot own children.
      const third = await call(
        `/api/tasks/${child.id}/children`,
        "POST",
        { title: "Grandchild" },
        { "Idempotency-Key": randomUUID() },
      );
      expect(third.status).toBe(409);
      expect(await third.json()).toMatchObject({
        code: "TASK_HIERARCHY_DEPTH",
      });

      const moveRequest = (taskId: string, revision: number, body: unknown) =>
        call(`/api/tasks/${taskId}/move`, "POST", body, {
          "If-Match": `"${String(revision)}"`,
        });
      expect(
        (await moveRequest(parent.id, parent.revision, { parentId: other.id }))
          .status,
      ).toBe(409);
      expect((await moveRequest(second.id, 1, { parentId: null })).status).toBe(
        412,
      );
      const cycle = await moveRequest(other.id, other.revision, {
        parentId: other.id,
      });
      expect(await cycle.json()).toMatchObject({
        code: "TASK_HIERARCHY_CYCLE",
      });
      const moved = await moveRequest(second.id, second.revision, {
        parentId: parent.id,
        index: 0,
      });
      expect(moved.status).toBe(200);
      const children = async () =>
        taskChildrenResponseSchema.parse(
          await (await call(`/api/tasks/${parent.id}/children`, "GET")).json(),
        ).children;
      expect((await children()).map(({ title }) => title)).toEqual([
        "Second child",
        "First child",
      ]);
      const current = await children();
      const staleOrder = await call(`/api/tasks/${parent.id}/children`, "PUT", {
        items: current.map(({ id }) => ({ id, revision: 1 })),
      });
      expect(staleOrder.status).toBe(412);
      const reordered = await call(`/api/tasks/${parent.id}/children`, "PUT", {
        items: current
          .toReversed()
          .map(({ id, revision }) => ({ id, revision })),
      });
      expect(reordered.status).toBe(200);
      expect((await children()).map(({ title }) => title)).toEqual([
        "First child",
        "Second child",
      ]);

      // Convert a child to top level, then delete the parent: the remaining
      // child is soft-deleted with it and restored with it.
      const secondNow = (await children()).find(({ id }) => id === second.id);
      const promoted = await moveRequest(second.id, secondNow?.revision ?? 0, {
        parentId: null,
      });
      expect(await promoted.json()).toMatchObject({
        task: { parentId: null, childPosition: null },
      });
      const parentNow = taskSchema.parse(
        (
          (await (await call("/api/tasks", "GET")).json()) as {
            tasks: unknown[];
          }
        ).tasks.find((task) => (task as { id: string }).id === parent.id),
      );
      expect(
        (
          await call(`/api/tasks/${parent.id}`, "DELETE", undefined, {
            "If-Match": `"${String(parentNow.revision)}"`,
          })
        ).status,
      ).toBe(200);
      const recovery = (await (
        await call("/api/tasks/recovery", "GET")
      ).json()) as { tasks: { id: string; revision: number }[] };
      expect(recovery.tasks.map(({ id }) => id).toSorted()).toEqual(
        [parent.id, child.id].toSorted(),
      );
      const deletedParent = recovery.tasks.find(({ id }) => id === parent.id);
      expect(
        (
          await call(
            `/api/tasks/${parent.id}/restore`,
            "POST",
            {},
            { "If-Match": `"${String(deletedParent?.revision ?? 0)}"` },
          )
        ).status,
      ).toBe(200);

      await server.close();
      server = await startSuiteServer(configuration(directory));
      call = await signIn(server);
      expect((await children()).map(({ id }) => id)).toEqual([child.id]);
    } finally {
      await server.close();
    }
  });
});

it("replays offline task.move operations and reports conflicts without changing the graph", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const server = await startSuiteServer(configuration(directory));
    try {
      const call = await signIn(server);
      const client = clientRegistrationResponseSchema.parse(
        await (await call("/api/clients", "POST", { label: "Laptop" })).json(),
      );
      const proof = {
        "X-Suite-Client-Id": client.client.id,
        "X-Suite-Client-Credential": client.clientCredential,
        "X-Suite-Sync-Version": "2",
      };
      const ids = [randomUUID(), randomUUID(), randomUUID()] as const;
      let sequence = 0;
      const base = () => ({
        operationId: randomUUID(),
        clientSequence: ++sequence,
        createdAt: new Date().toISOString(),
        requestHash: "a".repeat(43),
      });
      const round = async (operations: unknown[]) => {
        const response = await call(
          "/api/sync/round",
          "POST",
          { cursor: null, operations, pullLimit: 100 },
          proof,
        );
        expect(response.status).toBe(200);
        return syncRoundResponseSchema.parse(await response.json());
      };
      // Offline create of a parent and child followed by the child move.
      const move = {
        ...base(),
        kind: "task.move",
        taskId: ids[1],
        parentId: ids[0],
        index: null,
        baseParentVersion: 1,
      };
      const first = await round([
        ...[ids[0], ids[1], ids[2]].map((id) => ({
          ...base(),
          kind: "task.create",
          task: { id, title: id, notes: "", estimateMinutes: null },
        })),
        move,
      ]);
      expect(first.outcomes.map(({ kind }) => kind)).toEqual([
        "applied",
        "applied",
        "applied",
        "applied",
      ]);
      const replayed = await round([move]);
      expect(replayed.outcomes[0]).toMatchObject({ kind: "replayed" });
      // A queued move under the child would create a third level.
      const invalid = await round([
        {
          ...base(),
          kind: "task.move",
          taskId: ids[2],
          parentId: ids[1],
          index: null,
          baseParentVersion: 1,
        },
      ]);
      expect(invalid.outcomes[0]).toMatchObject({
        kind: "conflict",
        code: "SYNC_RESOURCE_CONFLICT",
        taskId: ids[2],
      });
      // A stale base version is a conflict, not a silent overwrite.
      const stale = await round([
        { ...move, ...base(), parentId: null, baseParentVersion: 1 },
      ]);
      expect(stale.outcomes[0]).toMatchObject({ kind: "conflict" });
      const snapshot = syncSnapshotResponseSchema.parse(
        await (
          await call("/api/sync/snapshot", "GET", undefined, proof)
        ).json(),
      );
      const tasks = snapshot.snapshots.flatMap((entry) =>
        entry.entityKind === "task" ? [entry.value] : [],
      );
      const child = tasks.find(({ task }) => task.id === ids[1]);
      expect(child?.task.parentId).toBe(ids[0]);
      expect(child?.fieldVersions.parent).toBe(child?.task.revision);
      expect(tasks.find(({ task }) => task.id === ids[2])?.task.parentId).toBe(
        null,
      );
    } finally {
      await server.close();
    }
  });
});

it("previews and confirms assistant hierarchy changes with revision guards", async () => {
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
      const automation = (path: string, body: unknown) =>
        fetch(`${server.baseUrl}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
      const preview = async (input: unknown) => {
        const response = await automation("/api/automation/v1/previews", {
          operation: "tasks.hierarchy",
          input,
        });
        return {
          status: response.status,
          body: (await response.json()) as unknown,
        };
      };
      const confirm = async (previewId: string) => {
        const response = await automation(
          `/api/automation/v1/previews/${previewId}/confirm`,
          { idempotencyKey: randomUUID() },
        );
        return {
          status: response.status,
          body: (await response.json()) as unknown,
        };
      };
      const parent = taskMutationResponseSchema.parse(
        await (
          await call(
            "/api/tasks",
            "POST",
            { title: "Plan trip" },
            { "Idempotency-Key": randomUUID() },
          )
        ).json(),
      ).task;
      const created = await preview({
        action: "create_child",
        parentId: parent.id,
        expectedParentRevision: parent.revision,
        task: { title: "Book train", notes: "Window seat" },
      });
      expect(created.status).toBe(201);
      const createdPreview = automationPreviewResponseSchema.parse(
        created.body,
      ).preview;
      expect(createdPreview.summary).toContain('Add child task "Book train"');
      const createdResult = await confirm(createdPreview.id);
      expect(createdResult.status).toBe(200);
      const hierarchy = automationConfirmationResponseSchema.parse(
        createdResult.body,
      ).result;
      if (!("hierarchy" in hierarchy)) throw new Error("Expected hierarchy");
      const child = hierarchy.hierarchy.task;
      expect(child).toMatchObject({
        parentId: parent.id,
        notes: "Window seat",
      });

      // Preview, then change the child elsewhere: confirmation is stale.
      const promote = automationPreviewResponseSchema.parse(
        (
          await preview({
            action: "move",
            taskId: child?.id,
            expectedRevision: child?.revision,
            parentId: null,
          })
        ).body,
      ).preview;
      expect(promote.summary).toContain("top-level");
      await call(
        `/api/tasks/${child?.id ?? ""}`,
        "PATCH",
        { title: "Book train tickets" },
        { "If-Match": `"${String(child?.revision)}"` },
      );
      expect((await confirm(promote.id)).status).toBe(412);
      const invalid = await preview({
        action: "move",
        taskId: parent.id,
        expectedRevision: parent.revision + 1,
        parentId: child?.id,
      });
      expect(invalid.status).toBe(412);
      const reorderStale = await preview({
        action: "reorder",
        parentId: parent.id,
        expectedParentRevision: 1,
        items: [],
      });
      expect(reorderStale.status).toBe(412);
    } finally {
      await server.close();
    }
  });
});
