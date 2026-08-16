import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  automationConfirmationResponseSchema,
  automationPreviewResponseSchema,
  choicePoolLibraryResponseSchema,
  choicePoolSuggestionResponseSchema,
  clientRegistrationResponseSchema,
  planningPlaceholderResolutionResponseSchema,
  planningPlaceholderSchema,
  syncSnapshotResponseSchema,
  taskListResponseSchema,
} from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer } from "./server.ts";

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

describe("Phase 6 choice pool integration", () => {
  it("explains inert choices and resolves one placeholder once across clients, restart, and automation", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, "web"));
      await writeFile(join(directory, "web", "index.html"), "<h1>Suite</h1>");
      const config = configuration(directory);
      let server = await startSuiteServer(config);
      const post = (
        path: string,
        body: unknown,
        cookie: string,
        csrfToken: string,
        extra: Record<string, string> = {},
      ) =>
        fetch(`${server.baseUrl}${path}`, {
          method: "POST",
          headers: {
            Origin: server.baseUrl,
            Cookie: cookie,
            "X-CSRF-Token": csrfToken,
            "Content-Type": "application/json",
            ...extra,
          },
          body: JSON.stringify(body),
        });
      try {
        expect(
          (
            await fetch(`${server.baseUrl}/api/setup`, {
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
            })
          ).status,
        ).toBe(201);
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
        const createParent = async (title: string, key: string) => {
          const response = await post(
            "/api/tasks",
            { title, notes: "" },
            cookie,
            csrfToken,
            { "Idempotency-Key": key },
          );
          expect(response.status).toBe(201);
          return (await response.json()) as { task: { id: string } };
        };
        const parent = await createParent("Leg day", "phase6-parent-001");
        const poolResponse = await post(
          "/api/pools",
          {
            title: "Leg exercises",
            policy: "cycle",
            pickCount: 2,
            cooldownSeconds: null,
            items: [
              { title: "Squat" },
              { title: "Lunge" },
              { title: "Calf raise" },
              { title: "Leg curl" },
            ],
          },
          cookie,
          csrfToken,
        );
        expect(poolResponse.status).toBe(201);
        const createdPool = (await poolResponse.json()) as {
          pool: { id: string };
          items: { id: string }[];
        };
        const editedPool = await fetch(
          `${server.baseUrl}/api/pools/${createdPool.pool.id}`,
          {
            method: "PATCH",
            headers: {
              Origin: server.baseUrl,
              Cookie: cookie,
              "X-CSRF-Token": csrfToken,
              "Content-Type": "application/json",
              "If-Match": '"1"',
            },
            body: JSON.stringify({
              title: "Leg exercise rotation",
              policy: "cycle",
              pickCount: 2,
              cooldownSeconds: null,
              items: ["Squat", "Lunge", "Calf raise", "Leg curl"].map(
                (title, index) => ({
                  id: createdPool.items[index]?.id,
                  title,
                }),
              ),
            }),
          },
        );
        expect(editedPool.status).toBe(200);
        const taskList = taskListResponseSchema.parse(
          await (
            await fetch(`${server.baseUrl}/api/tasks`, {
              headers: { Cookie: cookie },
            })
          ).json(),
        );
        expect(taskList.tasks).toHaveLength(1);
        expect(JSON.stringify(taskList)).not.toContain("Squat");
        const placeholderResponse = await post(
          "/api/placeholders",
          { taskId: parent.task.id, poolId: createdPool.pool.id },
          cookie,
          csrfToken,
        );
        expect(placeholderResponse.status).toBe(201);
        const placeholder = planningPlaceholderSchema.parse(
          await placeholderResponse.json(),
        );
        const logicalTime = "2026-08-07T12:00:00.000Z";
        const suggestion = choicePoolSuggestionResponseSchema.parse(
          await (
            await fetch(
              `${server.baseUrl}/api/placeholders/${placeholder.id}/suggestion?at=${encodeURIComponent(logicalTime)}`,
              { headers: { Cookie: cookie } },
            )
          ).json(),
        );
        expect(suggestion.selectedItemIds).toEqual(
          createdPool.items.slice(0, 2).map(({ id }) => id),
        );
        expect(suggestion.eligibility).toHaveLength(4);
        const registrations = await Promise.all(
          ["first", "second"].map(async (label) =>
            clientRegistrationResponseSchema.parse(
              await (
                await post(
                  "/api/clients",
                  { label: `Phase 6 ${label}` },
                  cookie,
                  csrfToken,
                )
              ).json(),
            ),
          ),
        );
        for (const client of registrations) {
          const snapshot = syncSnapshotResponseSchema.parse(
            await (
              await fetch(`${server.baseUrl}/api/sync/snapshot`, {
                headers: {
                  Cookie: cookie,
                  "X-Suite-Client-Id": client.client.id,
                  "X-Suite-Client-Credential": client.clientCredential,
                },
              })
            ).json(),
          );
          expect(
            snapshot.snapshots.map(({ entityKind }) => entityKind),
          ).toEqual(
            expect.arrayContaining(["choice_pool", "planning_placeholder"]),
          );
        }
        const resolutionBodies = [
          {
            selectedItemIds: suggestion.selectedItemIds,
            logicalTime,
            override: false,
            expectedRevision: 1,
            idempotencyKey: "phase6-race-winner",
          },
          {
            selectedItemIds: [
              createdPool.items[1]?.id,
              createdPool.items[2]?.id,
            ],
            logicalTime,
            override: false,
            expectedRevision: 1,
            idempotencyKey: "phase6-race-loser",
          },
        ];
        const raced = await Promise.all(
          resolutionBodies.map((body) =>
            post(
              `/api/placeholders/${placeholder.id}/resolve`,
              body,
              cookie,
              csrfToken,
            ),
          ),
        );
        expect(raced.map(({ status }) => status).sort()).toEqual([201, 412]);
        const winnerIndex = raced.findIndex(({ status }) => status === 201);
        const winnerResponse = raced[winnerIndex];
        if (winnerResponse === undefined)
          throw new Error("No placeholder race winner was returned");
        const winner = planningPlaceholderResolutionResponseSchema.parse(
          await winnerResponse.json(),
        );
        expect(winner.subtasks).toHaveLength(2);
        const completedHistory = winner.history[0];
        if (completedHistory === undefined)
          throw new Error("Resolution did not return selection history");
        const completion = await post(
          `/api/pools/${createdPool.pool.id}/items/${completedHistory.itemId}/completions`,
          {
            placeholderId: placeholder.id,
            occurredAt: "2026-08-07T13:00:00.000Z",
          },
          cookie,
          csrfToken,
        );
        expect(completion.status).toBe(201);
        await server.close();
        server = await startSuiteServer(config);
        const replay = await post(
          `/api/placeholders/${placeholder.id}/resolve`,
          resolutionBodies[winnerIndex],
          cookie,
          csrfToken,
        );
        expect(replay.status).toBe(200);
        expect(
          planningPlaceholderResolutionResponseSchema.parse(
            await replay.json(),
          ),
        ).toMatchObject({
          replayed: true,
          resolution: { id: winner.resolution.id },
          subtasks: winner.subtasks.map(({ id }) => ({ id })),
        });

        const project = (await (
          await post(
            "/api/projects",
            { title: "Template destination" },
            cookie,
            csrfToken,
          )
        ).json()) as { project: { id: string } };
        const template = (await (
          await post(
            "/api/templates",
            {
              title: "Pool-backed template",
              notes: "",
              estimateMinutes: null,
              suggestedProjectId: null,
              tagIds: [],
              subtasks: [{ title: "Warm up" }],
            },
            cookie,
            csrfToken,
          )
        ).json()) as { id: string };
        const slot = await post(
          `/api/templates/${template.id}/pool-slots`,
          { poolId: createdPool.pool.id, pickCount: 2, position: 1 },
          cookie,
          csrfToken,
        );
        expect(slot.status).toBe(201);
        const templateInstance = await post(
          `/api/templates/${template.id}/instantiate`,
          {
            destinationProjectId: project.project.id,
            idempotencyKey: "phase6-template-slot-001",
          },
          cookie,
          csrfToken,
        );
        expect(templateInstance.status).toBe(201);
        const poolsAfterTemplate = choicePoolLibraryResponseSchema.parse(
          await (
            await fetch(`${server.baseUrl}/api/pools`, {
              headers: { Cookie: cookie },
            })
          ).json(),
        );
        expect(
          poolsAfterTemplate.placeholders.some(
            ({ position, state }) => position === 1 && state === "unresolved",
          ),
        ).toBe(true);

        const automationParent = await createParent(
          "Automated choice",
          "phase6-parent-002",
        );
        const automationPlaceholder = planningPlaceholderSchema.parse(
          await (
            await post(
              "/api/placeholders",
              { taskId: automationParent.task.id, poolId: createdPool.pool.id },
              cookie,
              csrfToken,
            )
          ).json(),
        );
        const issued = await post(
          "/api/automation/tokens",
          {
            label: "Pool automation",
            scopes: ["pools:read", "pools:write"],
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
          cookie,
          csrfToken,
        );
        const token = ((await issued.json()) as { token: string }).token;
        const automation = (
          path: string,
          method: "GET" | "POST",
          body?: unknown,
        ) =>
          fetch(`${server.baseUrl}${path}`, {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              ...(body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
        expect(
          choicePoolLibraryResponseSchema.parse(
            await (
              await automation("/api/automation/v1/resources/pools", "GET")
            ).json(),
          ).pools,
        ).toHaveLength(1);
        const automationSuggestion = choicePoolSuggestionResponseSchema.parse(
          await (
            await fetch(
              `${server.baseUrl}/api/placeholders/${automationPlaceholder.id}/suggestion?at=${encodeURIComponent("2026-08-08T12:00:00.000Z")}`,
              { headers: { Cookie: cookie } },
            )
          ).json(),
        );
        const previewResponse = await automation(
          "/api/automation/v1/previews",
          "POST",
          {
            operation: "placeholders.resolve",
            input: {
              placeholderId: automationPlaceholder.id,
              selectedItemIds: automationSuggestion.selectedItemIds,
              logicalTime: automationSuggestion.logicalTime,
              override: false,
              expectedRevision: 1,
            },
          },
        );
        expect(previewResponse.status).toBe(201);
        const preview = automationPreviewResponseSchema.parse(
          await previewResponse.json(),
        ).preview;
        const confirm = () =>
          automation(
            `/api/automation/v1/previews/${preview.id}/confirm`,
            "POST",
            { idempotencyKey: "phase6-automation-001" },
          );
        const confirmed = await confirm();
        expect(confirmed.status).toBe(200);
        const confirmedBody = automationConfirmationResponseSchema.parse(
          await confirmed.json(),
        );
        expect(confirmedBody).toMatchObject({
          operation: "placeholders.resolve",
          replayed: false,
        });
        const confirmedReplay = await confirm();
        expect(confirmedReplay.status).toBe(200);
        expect(
          automationConfirmationResponseSchema.parse(
            await confirmedReplay.json(),
          ),
        ).toMatchObject({ replayed: true });
      } finally {
        await server.close();
      }
    });
  });
});
