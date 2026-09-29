import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  automationConfirmationResponseSchema,
  automationPreviewResponseSchema,
  automationTokenScopeSchema,
  choicePoolSuggestionResponseSchema,
  createAutomationTokenResponseSchema,
} from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer, type RunningSuiteServer } from "./server.ts";

// ADR 0036: assistant authoring of templates, sets, pools and placeholders.

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

const errorCode = async (response: Response): Promise<string> =>
  ((await response.json()) as { code: string }).code;

it("authors templates, sets, pools and placeholders through revision-bound previews with atomic receipts", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const server = await startSuiteServer(configuration(directory));
    try {
      const owner = {
        username: "librarian",
        displayName: "Librarian",
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
      const browser = (
        path: string,
        method = "GET",
        body?: unknown,
        revision?: number,
        extra: Record<string, string> = {},
      ) =>
        fetch(`${server.baseUrl}${path}`, {
          method,
          headers: {
            ...extra,
            Origin: server.baseUrl,
            Cookie: cookie,
            "X-CSRF-Token": csrfToken,
            ...(revision === undefined
              ? {}
              : { "If-Match": `"${String(revision)}"` }),
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const issue = async (scopes: string[]) =>
        createAutomationTokenResponseSchema.parse(
          await (
            await browser("/api/automation/tokens", "POST", {
              label: "Librarian",
              scopes,
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
            })
          ).json(),
        ).token;
      const token = await issue([...automationTokenScopeSchema.options]);
      const readOnly = await issue(["templates:read", "pools:read"]);
      const previewRequest = (
        operation: string,
        input: unknown,
        credential = token,
      ) =>
        automationRequest(
          server,
          credential,
          "/api/automation/v1/previews",
          "POST",
          { operation, input },
        );
      const preview = async (operation: string, input: unknown) => {
        const response = await previewRequest(operation, input);
        expect(response.status, await response.clone().text()).toBe(201);
        return automationPreviewResponseSchema.parse(await response.json())
          .preview;
      };
      const previewFails = async (
        operation: string,
        input: unknown,
        status: number,
        code: string,
      ) => {
        const response = await previewRequest(operation, input);
        expect(response.status).toBe(status);
        expect(await errorCode(response)).toBe(code);
      };
      const confirm = (id: string, key = randomUUID()) =>
        automationRequest(
          server,
          token,
          `/api/automation/v1/previews/${id}/confirm`,
          "POST",
          { idempotencyKey: key },
        );
      const apply = async (operation: string, input: unknown) => {
        const p = await preview(operation, input);
        const response = await confirm(p.id);
        expect(response.status, await response.clone().text()).toBe(200);
        return automationConfirmationResponseSchema.parse(await response.json())
          .result;
      };
      const template = (result: unknown) => {
        if (
          typeof result !== "object" ||
          result === null ||
          !("template" in result) ||
          !("blueprints" in result)
        )
          throw new Error("Expected a template result");
        return result as {
          template: {
            id: string;
            title: string;
            revision: number;
            tagIds: string[];
            suggestedProjectId: string | null;
            archivedAt: string | null;
          };
          blueprints: { title: string }[];
          poolSlots: { poolId: string; pickCount: number }[];
        };
      };
      const pool = (result: unknown) => {
        if (
          typeof result !== "object" ||
          result === null ||
          !("pool" in result) ||
          !("items" in result)
        )
          throw new Error("Expected a pool result");
        return result as {
          pool: { id: string; revision: number; title: string };
          items: { id: string; title: string; archivedAt: string | null }[];
          history: { kind: string; placeholderId: string | null }[];
        };
      };

      // Browser-owned fixtures: a project, a tag and a task with a subtask.
      const { project } = (await (
        await browser("/api/projects", "POST", { title: "Alpha" })
      ).json()) as { project: { id: string; revision: number } };
      const { tag } = (await (
        await browser("/api/tags", "POST", { title: "Deep" })
      ).json()) as { tag: { id: string; revision: number } };
      const { task } = (await (
        await browser(
          "/api/tasks",
          "POST",
          { title: "Plan the week" },
          undefined,
          {
            "Idempotency-Key": randomUUID(),
          },
        )
      ).json()) as { task: { id: string; revision: number } };
      expect(
        (
          await browser(`/api/tasks/${task.id}/subtasks`, "POST", {
            title: "Collect notes",
            position: 0,
          })
        ).status,
      ).toBe(201);

      // Scope: a read-only credential cannot preview authoring.
      expect(
        (
          await previewRequest(
            "templates.mutate",
            { action: "create", title: "Weekly review" },
            readOnly,
          )
        ).status,
      ).toBe(403);

      // Create: the suggested project and tag are checked and frozen.
      await previewFails(
        "templates.mutate",
        { action: "create", title: "Orphan", suggestedProjectId: randomUUID() },
        404,
        "INVALID_TEMPLATE_REFERENCES",
      );
      const createPreview = await preview("templates.mutate", {
        action: "create",
        title: "Weekly review",
        suggestedProjectId: project.id,
        tagIds: [tag.id],
        subtasks: [{ title: "Inbox zero" }, { title: "Calendar" }],
      });
      expect(createPreview.summary).toContain('"Weekly review"');
      expect(createPreview.baseRevisions).toEqual(
        expect.arrayContaining([
          { entityKind: "project", entityId: project.id, revision: 1 },
          { entityKind: "tag", entityId: tag.id, revision: 1 },
        ]),
      );
      const createKey = randomUUID();
      const created = await confirm(createPreview.id, createKey);
      expect(created.status).toBe(200);
      const weekly = template(
        automationConfirmationResponseSchema.parse(await created.json()).result,
      );
      expect(weekly.template.tagIds).toEqual([tag.id]);
      expect(weekly.blueprints.map(({ title }) => title)).toEqual([
        "Inbox zero",
        "Calendar",
      ]);

      // Identical replay returns the stored result without a second template.
      const replay = await confirm(createPreview.id, createKey);
      expect(replay.status).toBe(200);
      const replayed = (await replay.json()) as {
        replayed: boolean;
        result: { template: { id: string } };
      };
      expect(replayed.replayed).toBe(true);
      expect(replayed.result.template.id).toBe(weekly.template.id);
      expect((await confirm(createPreview.id, randomUUID())).status).toBe(409);
      const library = (await (
        await automationRequest(
          server,
          readOnly,
          "/api/automation/v1/resources/templates",
          "GET",
        )
      ).json()) as { templates: unknown[] };
      expect(library.templates).toHaveLength(1);

      // Update: a wrong revision fails at preview; a browser edit between
      // preview and confirmation makes the preview stale.
      await previewFails(
        "templates.mutate",
        {
          action: "update",
          templateId: weekly.template.id,
          expectedRevision: 7,
          title: "Weekly review (long)",
        },
        412,
        "REVISION_CONFLICT",
      );
      const stale = await preview("templates.mutate", {
        action: "update",
        templateId: weekly.template.id,
        expectedRevision: 1,
        estimateMinutes: 45,
      });
      expect(stale.summary).toContain("estimateMinutes");
      expect(
        (
          await browser(
            `/api/templates/${weekly.template.id}`,
            "PATCH",
            { title: "Weekly review (browser)" },
            1,
          )
        ).status,
      ).toBe(200);
      const staleConfirm = await confirm(stale.id);
      expect(staleConfirm.status).toBe(412);
      expect(await errorCode(staleConfirm)).toBe("AUTOMATION_PREVIEW_STALE");
      const updated = template(
        await apply("templates.mutate", {
          action: "update",
          templateId: weekly.template.id,
          expectedRevision: 2,
          estimateMinutes: 45,
          subtasks: [{ title: "Only one" }],
        }),
      );
      expect(updated.template.revision).toBe(3);
      expect(updated.template.title).toBe("Weekly review (browser)");
      expect(updated.blueprints.map(({ title }) => title)).toEqual([
        "Only one",
      ]);

      // From task: the source task revision is frozen; an edit is stale.
      const fromTask = await preview("templates.mutate", {
        action: "create_from_task",
        taskId: task.id,
        expectedTaskRevision: task.revision,
      });
      expect(
        (
          await browser(
            `/api/tasks/${task.id}`,
            "PATCH",
            { title: "Plan the month" },
            task.revision,
          )
        ).status,
      ).toBe(200);
      expect((await confirm(fromTask.id)).status).toBe(412);
      await previewFails(
        "templates.mutate",
        {
          action: "create_from_task",
          taskId: task.id,
          expectedTaskRevision: task.revision,
        },
        412,
        "REVISION_CONFLICT",
      );
      const monthly = template(
        await apply("templates.mutate", {
          action: "create_from_task",
          taskId: task.id,
          expectedTaskRevision: task.revision + 1,
        }),
      );
      expect(monthly.template.title).toBe("Plan the month");
      expect(monthly.blueprints.map(({ title }) => title)).toEqual([
        "Collect notes",
      ]);

      // Pools: creation checks the pick count; update freezes kept items.
      await previewFails(
        "pools.mutate",
        {
          action: "create",
          title: "Chores",
          policy: "none",
          pickCount: 3,
          cooldownSeconds: null,
          items: [{ title: "Dishes" }, { title: "Laundry" }],
        },
        400,
        "INVALID_CHOICE_POOL",
      );
      const chores = pool(
        await apply("pools.mutate", {
          action: "create",
          title: "Chores",
          policy: "cooldown",
          pickCount: 1,
          cooldownSeconds: 3600,
          items: [{ title: "Dishes" }, { title: "Laundry" }],
        }),
      );
      expect(chores.items.map(({ title }) => title)).toEqual([
        "Dishes",
        "Laundry",
      ]);
      const dishes = chores.items[0];
      if (dishes === undefined) throw new Error("Expected pool items");
      await previewFails(
        "pools.mutate",
        {
          action: "update",
          poolId: chores.pool.id,
          expectedRevision: 5,
          title: "Chores",
          policy: "cycle",
          pickCount: 1,
          cooldownSeconds: null,
          items: [{ id: dishes.id, title: "Dishes" }],
        },
        412,
        "REVISION_CONFLICT",
      );
      const updatePreview = await preview("pools.mutate", {
        action: "update",
        poolId: chores.pool.id,
        expectedRevision: chores.pool.revision,
        title: "House chores",
        policy: "cycle",
        pickCount: 1,
        cooldownSeconds: null,
        items: [{ id: dishes.id, title: "Wash dishes" }, { title: "Vacuum" }],
      });
      expect(updatePreview.baseRevisions).toEqual(
        expect.arrayContaining([
          {
            entityKind: "pool_item",
            entityId: dishes.id,
            revision: 1,
          },
        ]),
      );
      expect(updatePreview.summary).toContain("1 current item(s) are archived");
      const updatedPool = pool(
        automationConfirmationResponseSchema.parse(
          await (await confirm(updatePreview.id)).json(),
        ).result,
      );
      expect(updatedPool.pool.title).toBe("House chores");
      expect(
        updatedPool.items.map(({ title, archivedAt }) => [
          title,
          archivedAt === null,
        ]),
      ).toEqual([
        ["Wash dishes", true],
        ["Vacuum", true],
        ["Laundry", false],
      ]);

      // Slots: the pool must have enough active items; the slot is returned.
      await previewFails(
        "templates.mutate",
        {
          action: "add_pool_slot",
          templateId: monthly.template.id,
          expectedRevision: 1,
          poolId: chores.pool.id,
          pickCount: 5,
          position: 0,
        },
        409,
        "TEMPLATE_POOL_SLOT_INVALID",
      );
      await previewFails(
        "templates.mutate",
        {
          action: "add_pool_slot",
          templateId: monthly.template.id,
          expectedRevision: 1,
          poolId: randomUUID(),
          pickCount: 1,
          position: 0,
        },
        404,
        "CHOICE_POOL_NOT_FOUND",
      );
      const slotted = template(
        await apply("templates.mutate", {
          action: "add_pool_slot",
          templateId: monthly.template.id,
          expectedRevision: 1,
          poolId: chores.pool.id,
          pickCount: 1,
          position: 0,
        }),
      );
      expect(slotted.poolSlots).toEqual([
        expect.objectContaining({ poolId: chores.pool.id, pickCount: 1 }),
      ]);

      // Placeholders: creation freezes the task and pool; the suggestion
      // resource evaluates the policy for a read-only credential.
      await previewFails(
        "placeholders.create",
        { taskId: randomUUID(), poolId: chores.pool.id },
        404,
        "TASK_NOT_FOUND",
      );
      await previewFails(
        "placeholders.create",
        { taskId: task.id, poolId: chores.pool.id, pickCount: 9 },
        409,
        "PLACEHOLDER_RESOURCE_INVALID",
      );
      const placeholderPreview = await preview("placeholders.create", {
        taskId: task.id,
        poolId: chores.pool.id,
      });
      expect(placeholderPreview.baseRevisions).toEqual(
        expect.arrayContaining([
          { entityKind: "task", entityId: task.id, revision: 2 },
          {
            entityKind: "choice_pool",
            entityId: chores.pool.id,
            revision: updatedPool.pool.revision,
          },
        ]),
      );
      const placeholderResult = automationConfirmationResponseSchema.parse(
        await (await confirm(placeholderPreview.id)).json(),
      ).result;
      if (!("placeholder" in placeholderResult))
        throw new Error("Expected a placeholder");
      const placeholder = placeholderResult.placeholder as {
        id: string;
        pickCount: number;
        state: string;
      };
      expect(placeholder.pickCount).toBe(1);
      expect(placeholder.state).toBe("unresolved");
      const suggestionPath =
        "/api/automation/v1/resources/placeholder-suggestion";
      expect(
        (await automationRequest(server, readOnly, suggestionPath, "GET"))
          .status,
      ).toBe(400);
      expect(
        (
          await automationRequest(
            server,
            readOnly,
            `${suggestionPath}?placeholderId=${randomUUID()}`,
            "GET",
          )
        ).status,
      ).toBe(404);
      const suggestion = choicePoolSuggestionResponseSchema.parse(
        await (
          await automationRequest(
            server,
            readOnly,
            `${suggestionPath}?placeholderId=${placeholder.id}&at=2026-09-25T09:00:00.000Z`,
            "GET",
          )
        ).json(),
      );
      expect(suggestion.pool.id).toBe(chores.pool.id);
      expect(suggestion.selectedItemIds).toHaveLength(1);
      expect(suggestion.logicalTime).toBe("2026-09-25T09:00:00.000Z");

      // Completion history names the item and optional placeholder.
      await previewFails(
        "pools.mutate",
        {
          action: "record_completion",
          poolId: chores.pool.id,
          itemId: randomUUID(),
          occurredAt: "2026-09-25T10:00:00.000Z",
        },
        404,
        "POOL_ITEM_NOT_FOUND",
      );
      const completed = pool(
        await apply("pools.mutate", {
          action: "record_completion",
          poolId: chores.pool.id,
          itemId: dishes.id,
          placeholderId: placeholder.id,
          occurredAt: "2026-09-25T10:00:00.000Z",
        }),
      );
      expect(completed.history).toEqual([
        expect.objectContaining({
          kind: "completed",
          placeholderId: placeholder.id,
        }),
      ]);

      // Sets: members must be active templates; archive needs confirmation.
      const archived = template(
        await apply("templates.mutate", {
          action: "archive",
          templateId: weekly.template.id,
          expectedRevision: 3,
        }),
      );
      expect(archived.template.archivedAt).not.toBeNull();
      await previewFails(
        "template_sets.create",
        { title: "Reviews", templateIds: [weekly.template.id] },
        409,
        "INVALID_TEMPLATE_SET_MEMBERS",
      );
      const setPreview = await preview("template_sets.create", {
        title: "Reviews",
        templateIds: [monthly.template.id],
      });
      expect(setPreview.baseRevisions).toEqual([
        {
          entityKind: "template",
          entityId: monthly.template.id,
          revision: 1,
        },
      ]);
      const setResult = automationConfirmationResponseSchema.parse(
        await (await confirm(setPreview.id)).json(),
      ).result;
      if (!("set" in setResult)) throw new Error("Expected a set");
      expect(setResult.members).toEqual([
        expect.objectContaining({ templateId: monthly.template.id }),
      ]);

      // Audit rows cover the denial, previews and executions.
      const audit = (await (await browser("/api/automation/audit")).json()) as {
        entries: { operation: string; phase: string; outcome: string }[];
      };
      expect(audit.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: "templates.mutate",
            phase: "preview",
            outcome: "denied",
            errorCode: "AUTOMATION_SCOPE_DENIED",
          }),
          expect.objectContaining({
            operation: "templates.mutate",
            phase: "preview",
            outcome: "succeeded",
          }),
          expect.objectContaining({
            operation: "templates.mutate",
            phase: "execute",
            outcome: "succeeded",
          }),
          expect.objectContaining({
            operation: "templates.mutate",
            phase: "confirm",
            outcome: "replayed",
          }),
          expect.objectContaining({
            operation: "templates.mutate",
            phase: "confirm",
            outcome: "denied",
            errorCode: "AUTOMATION_PREVIEW_STALE",
          }),
          expect.objectContaining({
            operation: "template_sets.create",
            phase: "execute",
          }),
          expect.objectContaining({
            operation: "pools.mutate",
            phase: "execute",
          }),
          expect.objectContaining({
            operation: "placeholders.create",
            phase: "execute",
          }),
          expect.objectContaining({
            operation: "placeholders.suggestion",
            phase: "resource_read",
          }),
        ]),
      );
    } finally {
      await server.close();
    }
  });
});
