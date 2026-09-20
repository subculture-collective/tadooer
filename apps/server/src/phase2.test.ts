import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ManualSessionClock } from "@suite/domain";
import {
  activeSessionCommandResponseSchema,
  apiErrorSchema,
  clientRegistrationResponseSchema,
  syncRoundResponseSchema,
  syncSnapshotResponseSchema,
  taskMutationResponseSchema,
} from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer, type RunningSuiteServer } from "./server.ts";

const hash = "a".repeat(43);
const operationId = (tail: string): string =>
  `00000000-0000-4000-8000-0000000000${tail}`;

interface Client {
  readonly id: string;
  readonly credential: string;
}

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

const request = async (
  server: RunningSuiteServer,
  cookie: string,
  csrf: string,
  path: string,
  body: unknown,
  extra: Record<string, string> = {},
): Promise<Response> =>
  fetch(`${server.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.baseUrl,
      Cookie: cookie,
      "X-CSRF-Token": csrf,
      ...extra,
    },
    body: JSON.stringify(body),
  });

const register = async (
  server: RunningSuiteServer,
  cookie: string,
  csrf: string,
  label: string,
): Promise<Client> => {
  const response = await request(server, cookie, csrf, "/api/clients", {
    label,
  });
  expect(response.status).toBe(201);
  const body = clientRegistrationResponseSchema.parse(await response.json());
  return { id: body.client.id, credential: body.clientCredential };
};

const proof = (client: Client): Record<string, string> => ({
  "X-Suite-Client-Id": client.id,
  "X-Suite-Client-Credential": client.credential,
  "X-Suite-Sync-Version": "2",
});

describe("Phase 2 HTTP integration", () => {
  it("enforces client proof/revocation and applies replay-safe field-level sync", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, "web"));
      await writeFile(join(directory, "web", "index.html"), "<h1>Suite</h1>");
      const server = await startSuiteServer(configuration(directory));
      try {
        const setup = await fetch(`${server.baseUrl}/api/setup`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: server.baseUrl,
          },
          body: JSON.stringify({
            username: "owner",
            displayName: "Owner",
            password: "correct horse battery staple",
          }),
        });
        expect(setup.status).toBe(201);
        const login = await fetch(`${server.baseUrl}/api/auth/login`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: server.baseUrl,
          },
          body: JSON.stringify({
            username: "owner",
            password: "correct horse battery staple",
          }),
        });
        const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
        const session = (await login.json()) as { csrfToken: string };
        const first = await register(
          server,
          cookie,
          session.csrfToken,
          "Laptop",
        );
        const second = await register(
          server,
          cookie,
          session.csrfToken,
          "Desktop",
        );

        const taskId = operationId("01");
        const create = {
          kind: "task.create",
          operationId: operationId("11"),
          clientSequence: 1,
          createdAt: "2026-08-06T12:00:00.000Z",
          requestHash: hash,
          task: {
            id: taskId,
            title: "Original",
            notes: "",
            estimateMinutes: null,
          },
        };
        const sync = (
          client: Client,
          operations: readonly unknown[],
          cursor: string | null = null,
        ) =>
          request(
            server,
            cookie,
            session.csrfToken,
            "/api/sync/round",
            { cursor, operations, pullLimit: 100 },
            proof(client),
          );
        const withoutVersion = await request(
          server,
          cookie,
          session.csrfToken,
          "/api/sync/round",
          { invalid: "body" },
          {
            "X-Suite-Client-Id": first.id,
            "X-Suite-Client-Credential": first.credential,
          },
        );
        expect(withoutVersion.status).toBe(426);
        // A reset must be decided before executing or recording any operation.
        const invalidCursor = await sync(first, [create], "invalid-cursor");
        expect(invalidCursor.status).toBe(409);
        expect(await invalidCursor.json()).toMatchObject({
          code: "SYNC_CURSOR_EXPIRED",
        });
        const afterReset = await fetch(`${server.baseUrl}/api/tasks`, {
          headers: { Cookie: cookie },
        });
        expect(await afterReset.json()).toMatchObject({ tasks: [] });

        const created = await sync(first, [create]);
        expect(created.status).toBe(200);
        expect(
          syncRoundResponseSchema.parse(await created.json()).outcomes[0],
        ).toMatchObject({
          kind: "applied",
          entityId: taskId,
          entityRevision: 1,
        });
        const replay = await sync(first, [create]);
        expect(
          syncRoundResponseSchema.parse(await replay.json()).outcomes[0],
        ).toMatchObject({ kind: "replayed", entityId: taskId });
        const changedHash = await sync(first, [
          { ...create, requestHash: "b".repeat(43) },
        ]);
        expect(
          syncRoundResponseSchema.parse(await changedHash.json()).outcomes[0],
        ).toMatchObject({ kind: "rejected", code: "IDEMPOTENCY_CONFLICT" });

        const deadlineTaskId = operationId("71");
        const dated = await sync(first, [
          {
            ...create,
            operationId: operationId("72"),
            clientSequence: 20,
            task: {
              ...create.task,
              id: deadlineTaskId,
              deadline: { kind: "date", value: "2026-09-20" },
            },
          },
        ]);
        expect(dated.status).toBe(200);
        const datedBody = syncRoundResponseSchema.parse(await dated.json());
        const datedChange = datedBody.changes.find(
          ({ entityId }) => entityId === deadlineTaskId,
        );
        expect(datedChange?.snapshot).toMatchObject({
          value: {
            task: { deadline: { kind: "date", value: "2026-09-20" } },
            fieldVersions: { deadline: 1 },
          },
        });
        const deadlinePatch = {
          kind: "task.patch",
          operationId: operationId("73"),
          clientSequence: 21,
          createdAt: create.createdAt,
          requestHash: hash,
          taskId: deadlineTaskId,
          fields: {
            deadline: { kind: "instant", value: "2026-09-20T18:00:00.000Z" },
          },
          baseFieldVersions: { deadline: 1 },
        };
        const updatedDeadline = await sync(
          first,
          [deadlinePatch],
          datedBody.nextCursor,
        );
        expect(updatedDeadline.status).toBe(200);
        const updatedDeadlineBody = syncRoundResponseSchema.parse(
          await updatedDeadline.json(),
        );
        expect(updatedDeadlineBody.changes).toHaveLength(1);
        expect(updatedDeadlineBody.changes[0]?.snapshot).toMatchObject({
          value: {
            task: { deadline: deadlinePatch.fields.deadline },
            fieldVersions: { deadline: 2 },
          },
        });
        const staleDeadline = {
          ...deadlinePatch,
          operationId: operationId("74"),
          clientSequence: 22,
          fields: { deadline: null },
        };
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const conflict = await sync(second, [staleDeadline]);
          expect(
            syncRoundResponseSchema.parse(await conflict.json()).outcomes[0],
          ).toMatchObject({
            kind: "conflict",
            code: "SYNC_FIELD_CONFLICT",
            conflictingFields: ["deadline"],
          });
        }

        const titlePatch = {
          kind: "task.patch",
          operationId: operationId("12"),
          clientSequence: 2,
          createdAt: "2026-08-06T12:01:00.000Z",
          requestHash: hash,
          taskId,
          fields: { title: "Renamed" },
          baseFieldVersions: { title: 1 },
        };
        const notesPatch = {
          kind: "task.patch",
          operationId: operationId("13"),
          clientSequence: 1,
          createdAt: "2026-08-06T12:01:00.000Z",
          requestHash: hash,
          taskId,
          fields: { notes: "Offline note" },
          baseFieldVersions: { notes: 1 },
        };
        expect(
          syncRoundResponseSchema.parse(
            await (await sync(first, [titlePatch])).json(),
          ).outcomes[0],
        ).toMatchObject({ kind: "applied" });
        expect(
          syncRoundResponseSchema.parse(
            await (await sync(second, [notesPatch])).json(),
          ).outcomes[0],
        ).toMatchObject({ kind: "applied" });
        const staleTitle = await sync(second, [
          { ...titlePatch, operationId: operationId("14"), clientSequence: 2 },
        ]);
        expect(
          syncRoundResponseSchema.parse(await staleTitle.json()).outcomes[0],
        ).toMatchObject({
          kind: "conflict",
          code: "SYNC_FIELD_CONFLICT",
          conflictingFields: ["title"],
        });

        const badCursor = await sync(second, [], "other-epoch.0");
        expect(badCursor.status).toBe(409);
        expect(apiErrorSchema.parse(await badCursor.json())).toMatchObject({
          code: "SYNC_CURSOR_EXPIRED",
        });
        const snapshot = await fetch(`${server.baseUrl}/api/sync/snapshot`, {
          headers: { Cookie: cookie, ...proof(second) },
        });
        expect(snapshot.status).toBe(200);
        expect(
          syncSnapshotResponseSchema.parse(await snapshot.json()).snapshots,
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ entityKind: "task" }),
          ]),
        );

        const project = await request(
          server,
          cookie,
          session.csrfToken,
          "/api/projects",
          { title: "Home" },
        );
        expect(project.status).toBe(201);
        const projectBody = (await project.json()) as {
          project: { id: string; revision: number };
        };
        const tag = await request(
          server,
          cookie,
          session.csrfToken,
          "/api/tags",
          { title: "Urgent" },
        );
        expect(tag.status).toBe(201);
        const tagBody = (await tag.json()) as {
          tag: { id: string; revision: number };
        };
        const projects = await fetch(`${server.baseUrl}/api/projects`, {
          headers: { Cookie: cookie },
        });
        expect(await projects.json()).toMatchObject({
          projects: [expect.objectContaining({ title: "Home" })],
        });
        const tags = await fetch(`${server.baseUrl}/api/tags`, {
          headers: { Cookie: cookie },
        });
        expect(await tags.json()).toMatchObject({
          tags: [expect.objectContaining({ displayName: "Urgent" })],
        });

        const mutate = (
          path: string,
          method: "PATCH" | "PUT" | "DELETE",
          revision: number,
          body?: unknown,
        ) =>
          fetch(`${server.baseUrl}${path}`, {
            method,
            headers: {
              Origin: server.baseUrl,
              Cookie: cookie,
              "X-CSRF-Token": session.csrfToken,
              "If-Match": `"${String(revision)}"`,
              ...(body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        expect(
          (
            await mutate(
              `/api/projects/${projectBody.project.id}`,
              "PATCH",
              projectBody.project.revision,
              { title: "House" },
            )
          ).status,
        ).toBe(200);
        expect(
          (
            await mutate(`/api/tasks/${taskId}/project`, "PUT", 3, {
              projectId: projectBody.project.id,
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await mutate(`/api/tasks/${taskId}/tags`, "PUT", 4, {
              tagIds: [tagBody.tag.id],
            })
          ).status,
        ).toBe(200);
        const subtaskCreate = await request(
          server,
          cookie,
          session.csrfToken,
          `/api/tasks/${taskId}/subtasks`,
          { title: "First step", position: 0 },
        );
        expect(subtaskCreate.status).toBe(201);
        const subtask = (await subtaskCreate.json()) as {
          subtask: { id: string; title: string; revision: number };
        };
        const secondSubtaskCreate = await request(
          server,
          cookie,
          session.csrfToken,
          `/api/tasks/${taskId}/subtasks`,
          { title: "Second step", position: 1 },
        );
        expect(secondSubtaskCreate.status).toBe(201);
        const secondSubtask = (await secondSubtaskCreate.json()) as {
          subtask: { id: string; title: string; revision: number };
        };
        const reordered = await fetch(
          `${server.baseUrl}/api/tasks/${taskId}/subtasks`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Origin: server.baseUrl,
              Cookie: cookie,
              "X-CSRF-Token": session.csrfToken,
            },
            body: JSON.stringify({
              items: [
                {
                  id: secondSubtask.subtask.id,
                  revision: secondSubtask.subtask.revision,
                },
                { id: subtask.subtask.id, revision: subtask.subtask.revision },
              ],
            }),
          },
        );
        expect(reordered.status).toBe(200);
        expect(await reordered.json()).toMatchObject({
          subtasks: [
            { id: secondSubtask.subtask.id, position: 0, revision: 2 },
            { id: subtask.subtask.id, position: 1, revision: 2 },
          ],
        });
        const staleReorder = await fetch(
          `${server.baseUrl}/api/tasks/${taskId}/subtasks`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Origin: server.baseUrl,
              Cookie: cookie,
              "X-CSRF-Token": session.csrfToken,
            },
            body: JSON.stringify({
              items: [
                { id: subtask.subtask.id, revision: 1 },
                { id: secondSubtask.subtask.id, revision: 1 },
              ],
            }),
          },
        );
        expect(staleReorder.status).toBe(412);
        expect(
          (
            await mutate(`/api/subtasks/${subtask.subtask.id}`, "PATCH", 2, {
              completed: true,
            })
          ).status,
        ).toBe(200);
        expect(
          (await mutate(`/api/subtasks/${subtask.subtask.id}`, "DELETE", 3))
            .status,
        ).toBe(204);
        expect(
          (
            await mutate(
              `/api/tags/${tagBody.tag.id}`,
              "PATCH",
              tagBody.tag.revision,
              { archived: true },
            )
          ).status,
        ).toBe(200);

        const revoke = await fetch(
          `${server.baseUrl}/api/clients/${first.id}`,
          {
            method: "DELETE",
            headers: {
              Origin: server.baseUrl,
              Cookie: cookie,
              "X-CSRF-Token": session.csrfToken,
            },
          },
        );
        expect(revoke.status).toBe(204);
        const revoked = await sync(first, []);
        expect(revoked.status).toBe(401);
        expect(apiErrorSchema.parse(await revoked.json())).toMatchObject({
          code: "CLIENT_REVOKED",
        });
      } finally {
        await server.close();
      }
    });
  });

  it("persists one owner session across restart and applies owner/follower/takeover/expiry safely", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, "web"));
      await writeFile(join(directory, "web", "index.html"), "<h1>Suite</h1>");
      const config = configuration(directory);
      const clock = new ManualSessionClock("2026-08-06T12:00:00.000Z");
      let server = await startSuiteServer(config, { sessionClock: clock });
      let cookie = "";
      let csrf = "";
      try {
        await fetch(`${server.baseUrl}/api/setup`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: server.baseUrl,
          },
          body: JSON.stringify({
            username: "owner",
            displayName: "Owner",
            password: "correct horse battery staple",
          }),
        });
        const login = await fetch(`${server.baseUrl}/api/auth/login`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: server.baseUrl,
          },
          body: JSON.stringify({
            username: "owner",
            password: "correct horse battery staple",
          }),
        });
        cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
        csrf = ((await login.json()) as { csrfToken: string }).csrfToken;
        const owner = await register(server, cookie, csrf, "Owner browser");
        const follower = await register(
          server,
          cookie,
          csrf,
          "Follower browser",
        );
        const task = await request(
          server,
          cookie,
          csrf,
          "/api/tasks",
          { title: "Focus task", notes: "" },
          { "Idempotency-Key": "phase2-focus-task" },
        );
        const taskId = taskMutationResponseSchema.parse(await task.json()).task
          .id;
        const command = (client: Client, body: unknown) =>
          request(
            server,
            cookie,
            csrf,
            "/api/active-session/command",
            body,
            proof(client),
          );
        const started = activeSessionCommandResponseSchema.parse(
          await (
            await command(owner, {
              command: "start",
              idempotencyKey: "phase2-session-start",
              taskId,
            })
          ).json(),
        );
        expect(started.session).toMatchObject({
          state: "running",
          controllerClientId: owner.id,
          revision: 1,
        });
        expect(started.openedInterval).not.toBeNull();
        const followerPause = await command(follower, {
          command: "pause",
          idempotencyKey: "phase2-follower-pause",
          sessionId: started.session.id,
          expectedRevision: 1,
        });
        expect(followerPause.status).toBe(409);
        const takeover = activeSessionCommandResponseSchema.parse(
          await (
            await command(follower, {
              command: "takeover",
              idempotencyKey: "phase2-takeover",
              sessionId: started.session.id,
              expectedRevision: 1,
            })
          ).json(),
        );
        expect(takeover.session).toMatchObject({
          controllerClientId: follower.id,
          revision: 2,
        });
        expect(takeover.openedInterval).not.toBeNull();
        expect(takeover.closedInterval).not.toBeNull();
        const oldOwner = await command(owner, {
          command: "heartbeat",
          idempotencyKey: "phase2-old-owner",
          sessionId: started.session.id,
          expectedRevision: 2,
        });
        expect(oldOwner.status).toBe(409);

        await server.close();
        server = await startSuiteServer(config, { sessionClock: clock });
        const afterRestart = await fetch(
          `${server.baseUrl}/api/active-session`,
          { headers: { Cookie: cookie, ...proof(follower) } },
        );
        expect(
          (await afterRestart.json()) as { session: unknown },
        ).toMatchObject({
          session: {
            id: started.session.id,
            controllerClientId: follower.id,
            revision: 2,
          },
        });
        clock.advanceSeconds(91);
        const expired = await fetch(`${server.baseUrl}/api/active-session`, {
          headers: { Cookie: cookie, ...proof(follower) },
        });
        expect((await expired.json()) as { session: unknown }).toMatchObject({
          session: { state: "expired", revision: 3, currentIntervalId: null },
        });
      } finally {
        await server.close();
      }
    });
  });
});
