import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  clientRegistrationResponseSchema,
  syncRoundResponseSchema,
  syncSnapshotResponseSchema,
  taskMutationResponseSchema,
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
    username: "structural",
    displayName: "Structural",
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

it("queues planning, assignment, project, tag and checklist writes through sync v2 with idempotent replay and conflicts", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const server = await startSuiteServer(configuration(directory));
    try {
      const call = await signIn(server);
      const register = async (label: string) => {
        const client = clientRegistrationResponseSchema.parse(
          await (await call("/api/clients", "POST", { label })).json(),
        );
        return {
          "X-Suite-Client-Id": client.client.id,
          "X-Suite-Client-Credential": client.clientCredential,
          "X-Suite-Sync-Version": "2",
        };
      };
      const laptop = await register("Laptop");
      const phone = await register("Phone");
      let sequence = 0;
      const base = () => ({
        operationId: randomUUID(),
        clientSequence: ++sequence,
        createdAt: "2026-09-25T12:00:00.000Z",
        requestHash: "a".repeat(43),
      });
      const round = async (
        proof: Record<string, string>,
        operations: unknown[],
      ) => {
        const response = await call(
          "/api/sync/round",
          "POST",
          { cursor: null, operations, pullLimit: 100 },
          proof,
        );
        expect(response.status).toBe(200);
        return syncRoundResponseSchema.parse(await response.json());
      };
      const task = taskMutationResponseSchema.parse(
        await (
          await call(
            "/api/tasks",
            "POST",
            { title: "Task" },
            { "Idempotency-Key": randomUUID() },
          )
        ).json(),
      ).task;
      const snapshot = syncSnapshotResponseSchema.parse(
        await (
          await call("/api/sync/snapshot", "GET", undefined, laptop)
        ).json(),
      );
      const cachedTask = snapshot.snapshots.find(
        (entry) => entry.entityKind === "task",
      );
      expect(
        cachedTask?.entityKind === "task" && cachedTask.value,
      ).toMatchObject({ fieldVersions: { plannedStart: 1 } });

      // Offline on the laptop: a project, a tag, assignment, a planned day
      // and a checklist item, replayed in one round.
      const projectId = randomUUID();
      const tagId = randomUUID();
      const itemId = randomUUID();
      const offline = [
        {
          ...base(),
          kind: "project.create",
          project: { id: projectId, title: "Home" },
        },
        { ...base(), kind: "tag.create", tag: { id: tagId, title: "Errand" } },
        {
          ...base(),
          kind: "task.patch",
          taskId: task.id,
          fields: { projectId, tagIds: [tagId], plannedDay: "2026-09-26" },
          baseFieldVersions: { projectId: 1, tagIds: 1, plannedStart: 1 },
        },
        {
          ...base(),
          kind: "subtask.create",
          subtask: { id: itemId, taskId: task.id, title: "Step", position: 0 },
        },
      ];
      const first = await round(laptop, offline);
      expect(first.outcomes.map(({ kind }) => kind)).toEqual([
        "applied",
        "applied",
        "applied",
        "applied",
      ]);
      expect(first.outcomes[0]).toMatchObject({ entityId: projectId });
      expect(
        first.changes.map(({ entityKind, kind }) => `${entityKind}:${kind}`),
      ).toEqual([
        "task:upsert",
        "project:upsert",
        "tag:upsert",
        "task:upsert",
        "subtask:upsert",
      ]);
      const patched = first.changes.find(
        (change) => change.entityKind === "task" && change.sequence === 4,
      );
      expect(patched?.snapshot).toMatchObject({
        value: {
          task: { projectId, tagIds: [tagId], plannedDay: "2026-09-26" },
          fieldVersions: { projectId: 2, tagIds: 2, plannedStart: 2, title: 1 },
        },
      });
      const replay = await round(laptop, offline);
      expect(replay.outcomes.map(({ kind }) => kind)).toEqual([
        "replayed",
        "replayed",
        "replayed",
        "replayed",
      ]);
      expect(replay.changes).toHaveLength(5);

      // The phone edited the same slot and tag online meanwhile: stale
      // planning is a field conflict; a stale tag patch and a used ID are
      // resource conflicts naming the entity; nothing changes.
      const online = await call(
        `/api/tasks/${task.id}`,
        "PATCH",
        { plannedStart: "2026-09-27T09:00:00.000Z" },
        { "If-Match": `"${String(2)}"` },
      );
      expect(online.status).toBe(200);
      const conflicts = await round(phone, [
        {
          ...base(),
          kind: "task.patch",
          taskId: task.id,
          fields: { plannedDay: "2026-09-28" },
          baseFieldVersions: { plannedStart: 2 },
        },
        {
          ...base(),
          kind: "tag.patch",
          tagId,
          fields: { archived: true },
          baseRevision: 7,
        },
        {
          ...base(),
          kind: "project.create",
          project: { id: projectId, title: "Dup" },
        },
        {
          ...base(),
          kind: "subtask.patch",
          subtaskId: itemId,
          fields: { completed: true },
          baseRevision: 1,
        },
        {
          ...base(),
          kind: "subtask.delete",
          subtaskId: itemId,
          baseRevision: 1,
        },
      ]);
      expect(conflicts.outcomes).toMatchObject([
        {
          kind: "conflict",
          code: "SYNC_FIELD_CONFLICT",
          entityKind: "task",
          taskId: task.id,
          conflictingFields: ["plannedStart"],
        },
        {
          kind: "conflict",
          code: "SYNC_RESOURCE_CONFLICT",
          entityKind: "tag",
          taskId: tagId,
          taskRevision: 1,
        },
        {
          kind: "conflict",
          code: "SYNC_RESOURCE_CONFLICT",
          entityKind: "project",
          taskId: projectId,
        },
        { kind: "applied", entityId: itemId, entityRevision: 2 },
        {
          kind: "conflict",
          code: "SYNC_RESOURCE_CONFLICT",
          entityKind: "subtask",
          taskId: itemId,
          taskRevision: 2,
        },
      ]);
      const tags = (await (await call("/api/tags", "GET")).json()) as {
        tags: readonly { id: string; archivedAt: string | null }[];
      };
      expect(tags.tags.find(({ id }) => id === tagId)?.archivedAt).toBeNull();
      const subtasks = (await (
        await call(`/api/tasks/${task.id}/subtasks`, "GET")
      ).json()) as { subtasks: readonly { id: string; completed: boolean }[] };
      expect(subtasks.subtasks).toEqual([
        expect.objectContaining({ id: itemId, completed: true }),
      ]);
      const list = (await (await call("/api/tasks", "GET")).json()) as {
        tasks: readonly {
          id: string;
          plannedStart: string | null;
          plannedDay?: string | null;
        }[];
      };
      expect(list.tasks.find(({ id }) => id === task.id)).toMatchObject({
        plannedStart: "2026-09-27T09:00:00.000Z",
        plannedDay: null,
      });
    } finally {
      await server.close();
    }
  });
});
