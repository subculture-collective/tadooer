import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  automationConfirmationResponseSchema,
  automationPreviewResponseSchema,
  automationTaskResourceSchema,
  clientRegistrationResponseSchema,
  plannerResponseSchema,
  syncSnapshotResponseSchema,
  taskListResponseSchema,
  taskTemplateLibraryResponseSchema,
  taskTemplateSchema,
  templateInstantiationResponseSchema,
  templateSetLibraryResponseSchema,
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

const browserRequest = (
  server: RunningSuiteServer,
  cookie: string,
  csrfToken: string,
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
  revision?: number,
): Promise<Response> =>
  fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      Origin: server.baseUrl,
      Cookie: cookie,
      "X-CSRF-Token": csrfToken,
      ...(revision === undefined
        ? {}
        : { "If-Match": `"${String(revision)}"` }),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const automationRequest = (
  server: RunningSuiteServer,
  token: string,
  path: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<Response> =>
  fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("Phase 5 reusable work HTTP integration", () => {
  it("keeps templates inert and instantiates an independent subtask tree exactly once across restart", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, "web"));
      await writeFile(join(directory, "web", "index.html"), "<h1>Suite</h1>");
      const config = configuration(directory);
      let server = await startSuiteServer(config);
      try {
        const setup = await fetch(`${server.baseUrl}/api/setup`, {
          method: "POST",
          headers: {
            Origin: server.baseUrl,
            "Content-Type": "application/json",
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
            Origin: server.baseUrl,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            username: "owner",
            password: "correct horse battery staple",
          }),
        });
        expect(login.status).toBe(200);
        const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
        const { csrfToken } = (await login.json()) as { csrfToken: string };

        const projectResponse = await browserRequest(
          server,
          cookie,
          csrfToken,
          "/api/projects",
          "POST",
          { title: "Destination" },
        );
        expect(projectResponse.status).toBe(201);
        const project = (await projectResponse.json()) as {
          project: { id: string };
        };
        const templateResponse = await browserRequest(
          server,
          cookie,
          csrfToken,
          "/api/templates",
          "POST",
          {
            title: "Quarterly review",
            notes: "Independent snapshot",
            estimateMinutes: 45,
            suggestedProjectId: project.project.id,
            tagIds: [],
            subtasks: [{ title: "Gather evidence" }, { title: "Write review" }],
          },
        );
        expect(templateResponse.status).toBe(201);
        const template = (await templateResponse.json()) as {
          id: string;
          revision: number;
        };

        const library = await fetch(
          `${server.baseUrl}/api/templates?query=quarterly`,
          { headers: { Cookie: cookie } },
        );
        expect(library.status).toBe(200);
        expect(
          taskTemplateLibraryResponseSchema.parse(await library.json()),
        ).toMatchObject({
          templates: [
            expect.objectContaining({
              id: template.id,
              title: "Quarterly review",
            }),
          ],
          blueprints: [
            expect.objectContaining({ title: "Gather evidence", position: 0 }),
            expect.objectContaining({ title: "Write review", position: 1 }),
          ],
        });
        const ordinaryTasks = await fetch(`${server.baseUrl}/api/tasks`, {
          headers: { Cookie: cookie },
        });
        expect(
          taskListResponseSchema.parse(await ordinaryTasks.json()).tasks,
        ).toEqual([]);
        const planner = await fetch(
          `${server.baseUrl}/api/planner?from=2026-08-06T00%3A00%3A00.000Z&to=2026-08-07T00%3A00%3A00.000Z`,
          { headers: { Cookie: cookie } },
        );
        expect(plannerResponseSchema.parse(await planner.json()).tasks).toEqual(
          [],
        );

        const invalidDestination = await browserRequest(
          server,
          cookie,
          csrfToken,
          `/api/templates/${template.id}/instantiate`,
          "POST",
          {
            destinationProjectId: "00000000-0000-4000-8000-000000000000",
            idempotencyKey: "phase5-invalid-destination",
          },
        );
        expect(invalidDestination.status).toBe(404);
        const first = await browserRequest(
          server,
          cookie,
          csrfToken,
          `/api/templates/${template.id}/instantiate`,
          "POST",
          {
            destinationProjectId: project.project.id,
            idempotencyKey: "phase5-tree-001",
          },
        );
        expect(first.status).toBe(201);
        const firstTree = templateInstantiationResponseSchema.parse(
          await first.json(),
        );
        expect(firstTree.replayed).toBe(false);
        const createdTree = firstTree.tasks[0];
        if (createdTree === undefined)
          throw new Error("Template confirmation did not return a task tree");
        expect(createdTree.task).toMatchObject({
          projectId: project.project.id,
          title: "Quarterly review",
        });
        expect(createdTree.subtasks).toEqual([
          expect.objectContaining({ title: "Gather evidence", position: 0 }),
          expect.objectContaining({ title: "Write review", position: 1 }),
        ]);
        expect(createdTree.provenance).toMatchObject({
          templateId: template.id,
          templateRevision: template.revision,
        });
        const firstIds = [
          createdTree.task.id,
          ...createdTree.subtasks.map(({ id }) => id),
        ];

        const patched = await browserRequest(
          server,
          cookie,
          csrfToken,
          `/api/templates/${template.id}`,
          "PATCH",
          { title: "Changed template", subtasks: [{ title: "New blueprint" }] },
          template.revision,
        );
        expect(patched.status).toBe(200);
        const persistedChildren = await fetch(
          `${server.baseUrl}/api/tasks/${createdTree.task.id}/subtasks`,
          { headers: { Cookie: cookie } },
        );
        const persistedSubtasks = (
          (await persistedChildren.json()) as {
            readonly subtasks: readonly { readonly title: string }[];
          }
        ).subtasks;
        expect(persistedSubtasks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ title: "Gather evidence" }),
            expect.objectContaining({ title: "Write review" }),
          ]),
        );

        const fromTaskResponse = await browserRequest(
          server,
          cookie,
          csrfToken,
          `/api/templates/from-task/${createdTree.task.id}`,
          "POST",
          { taskId: createdTree.task.id },
        );
        expect(fromTaskResponse.status).toBe(201);
        const fromTaskTemplate = (await fromTaskResponse.json()) as {
          readonly id: string;
          readonly revision: number;
          readonly title: string;
        };
        expect(fromTaskTemplate.title).toBe("Quarterly review");
        const archiveResponse = await browserRequest(
          server,
          cookie,
          csrfToken,
          `/api/templates/${fromTaskTemplate.id}/archive`,
          "POST",
          {},
          fromTaskTemplate.revision,
        );
        expect(archiveResponse.status).toBe(200);
        const archivedTemplate = taskTemplateSchema.parse(
          await archiveResponse.json(),
        );
        expect(archivedTemplate).toMatchObject({
          id: fromTaskTemplate.id,
          revision: fromTaskTemplate.revision + 1,
        });
        expect(archivedTemplate.archivedAt).toBeTypeOf("string");
        const archivedLibrary = await fetch(
          `${server.baseUrl}/api/templates?includeArchived=true`,
          { headers: { Cookie: cookie } },
        );
        const archivedLibraryEntry = taskTemplateLibraryResponseSchema
          .parse(await archivedLibrary.json())
          .templates.find(({ id }) => id === fromTaskTemplate.id);
        expect(archivedLibraryEntry).toMatchObject({
          id: fromTaskTemplate.id,
          revision: fromTaskTemplate.revision + 1,
        });
        expect(archivedLibraryEntry?.archivedAt).toBeTypeOf("string");

        await server.close();
        server = await startSuiteServer(config);
        const replay = await browserRequest(
          server,
          cookie,
          csrfToken,
          `/api/templates/${template.id}/instantiate`,
          "POST",
          {
            destinationProjectId: project.project.id,
            idempotencyKey: "phase5-tree-001",
          },
        );
        expect(replay.status).toBe(200);
        const replayTree = templateInstantiationResponseSchema.parse(
          await replay.json(),
        );
        expect(replayTree.replayed).toBe(true);
        expect(
          replayTree.tasks.flatMap(({ task, subtasks }) => [
            task.id,
            ...subtasks.map(({ id }) => id),
          ]),
        ).toEqual(firstIds);

        const listedAfterReplay = await fetch(`${server.baseUrl}/api/tasks`, {
          headers: { Cookie: cookie },
        });
        expect(
          taskListResponseSchema.parse(await listedAfterReplay.json()).tasks,
        ).toHaveLength(1);
        const restoredLibrary = taskTemplateLibraryResponseSchema.parse(
          await (
            await fetch(
              `${server.baseUrl}/api/templates?includeArchived=true`,
              { headers: { Cookie: cookie } },
            )
          ).json(),
        );
        expect(restoredLibrary.provenance).toContainEqual(
          expect.objectContaining({
            taskId: createdTree.task.id,
            templateId: template.id,
            instantiationId: firstTree.instantiationId,
          }),
        );
      } finally {
        await server.close();
      }
    });
  });

  it("instantiates a set into an explicit project only through confirmed automation", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, "web"));
      await writeFile(join(directory, "web", "index.html"), "<h1>Suite</h1>");
      const server = await startSuiteServer(configuration(directory));
      try {
        const setup = await fetch(`${server.baseUrl}/api/setup`, {
          method: "POST",
          headers: {
            Origin: server.baseUrl,
            "Content-Type": "application/json",
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
            Origin: server.baseUrl,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            username: "owner",
            password: "correct horse battery staple",
          }),
        });
        const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
        const { csrfToken } = (await login.json()) as { csrfToken: string };
        const project = (await (
          await browserRequest(
            server,
            cookie,
            csrfToken,
            "/api/projects",
            "POST",
            { title: "Automation destination" },
          )
        ).json()) as { project: { id: string } };
        const template = (await (
          await browserRequest(
            server,
            cookie,
            csrfToken,
            "/api/templates",
            "POST",
            {
              title: "Automated template",
              notes: "",
              estimateMinutes: null,
              suggestedProjectId: null,
              tagIds: [],
              subtasks: [{ title: "Synced blueprint" }],
            },
          )
        ).json()) as { id: string };
        const set = await browserRequest(
          server,
          cookie,
          csrfToken,
          "/api/template-sets",
          "POST",
          { title: "Automation set", templateIds: [template.id] },
        );
        expect(set.status).toBe(201);
        const templateSet = (await set.json()) as { id: string };
        const sets = await fetch(`${server.baseUrl}/api/template-sets`, {
          headers: { Cookie: cookie },
        });
        expect(
          templateSetLibraryResponseSchema.parse(await sets.json()),
        ).toMatchObject({
          sets: [expect.objectContaining({ id: templateSet.id })],
          members: [
            expect.objectContaining({ templateId: template.id, position: 0 }),
          ],
        });
        const registration = await browserRequest(
          server,
          cookie,
          csrfToken,
          "/api/clients",
          "POST",
          { label: "Phase 5 sync verifier" },
        );
        expect(registration.status).toBe(201);
        const client = clientRegistrationResponseSchema.parse(
          await registration.json(),
        );
        const snapshotResponse = await fetch(
          `${server.baseUrl}/api/sync/snapshot`,
          {
            headers: {
              Cookie: cookie,
              "X-Suite-Client-Id": client.client.id,
              "X-Suite-Client-Credential": client.clientCredential,
            },
          },
        );
        expect(snapshotResponse.status).toBe(200);
        const snapshots = syncSnapshotResponseSchema.parse(
          await snapshotResponse.json(),
        ).snapshots;
        const snapshotKinds = snapshots.map(({ entityKind }) => entityKind);
        expect(snapshotKinds).toEqual(
          expect.arrayContaining(["template", "template_set"]),
        );
        expect(snapshotKinds).not.toContain("task");
        const templateSnapshot = snapshots.find(
          ({ entityKind }) => entityKind === "template",
        );
        expect(
          templateSnapshot?.entityKind === "template"
            ? templateSnapshot.value.blueprints
            : [],
        ).toEqual([
          expect.objectContaining({
            templateId: template.id,
            title: "Synced blueprint",
            position: 0,
          }),
        ]);
        const setSnapshot = snapshots.find(
          ({ entityKind }) => entityKind === "template_set",
        );
        expect(
          setSnapshot?.entityKind === "template_set"
            ? setSnapshot.value.members
            : [],
        ).toEqual([
          expect.objectContaining({
            setId: templateSet.id,
            templateId: template.id,
            position: 0,
          }),
        ]);
        const issued = await browserRequest(
          server,
          cookie,
          csrfToken,
          "/api/automation/tokens",
          "POST",
          {
            label: "Template automation",
            scopes: ["templates:read", "templates:write", "tasks:read"],
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        );
        expect(issued.status).toBe(201);
        const credential = (await issued.json()) as { token: string };
        const templateResource = await automationRequest(
          server,
          credential.token,
          "/api/automation/v1/resources/templates",
          "GET",
        );
        expect(templateResource.status).toBe(200);
        expect(JSON.stringify(await templateResource.json())).toContain(
          template.id,
        );
        const taskResource = await automationRequest(
          server,
          credential.token,
          "/api/automation/v1/resources/tasks",
          "GET",
        );
        expect(
          automationTaskResourceSchema.parse(await taskResource.json()).tasks,
        ).toEqual([]);
        const previewResponse = await automationRequest(
          server,
          credential.token,
          "/api/automation/v1/previews",
          "POST",
          {
            operation: "template_sets.instantiate",
            input: {
              setId: templateSet.id,
              destinationProjectId: project.project.id,
            },
          },
        );
        expect(previewResponse.status).toBe(201);
        const preview = automationPreviewResponseSchema.parse(
          await previewResponse.json(),
        ).preview;
        const confirm = () =>
          automationRequest(
            server,
            credential.token,
            `/api/automation/v1/previews/${preview.id}/confirm`,
            "POST",
            { idempotencyKey: "phase5-automation-set-001" },
          );
        const first = await confirm();
        expect(first.status).toBe(200);
        expect(
          automationConfirmationResponseSchema.parse(await first.json()),
        ).toMatchObject({
          operation: "template_sets.instantiate",
          replayed: false,
        });
        const replay = await confirm();
        expect(replay.status).toBe(200);
        expect(
          automationConfirmationResponseSchema.parse(await replay.json()),
        ).toMatchObject({ replayed: true });
        const tasksAfterReplay = await automationRequest(
          server,
          credential.token,
          "/api/automation/v1/resources/tasks",
          "GET",
        );
        expect(
          automationTaskResourceSchema.parse(await tasksAfterReplay.json())
            .tasks,
        ).toHaveLength(1);
      } finally {
        await server.close();
      }
    });
  });
});
