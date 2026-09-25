import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  automationConfirmationResponseSchema,
  automationPreviewResponseSchema,
  automationTokenScopeSchema,
  capturePreferencesResponseSchema,
  capturePreviewResponseSchema,
  createAutomationTokenResponseSchema,
  taskBatchMutationResponseSchema,
  taskMutationResponseSchema,
} from "@suite/contracts";
import { ManualSessionClock } from "@suite/domain";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer, type RunningSuiteServer } from "./server.ts";

// Capture syntax over HTTP and the assistant (#90, ADR 0031).
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
  username: "capturer",
  displayName: "Capturer",
  password: "a sufficiently long disposable password",
};

const signIn = async (server: RunningSuiteServer) => {
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
    method: "GET" | "POST" | "PUT",
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

it("requires owner consent for new tags, previews pastes, creates batches and stores the URL preference", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const clock = new ManualSessionClock("2026-09-19T12:00:00.000Z");
    const server = await startSuiteServer(configuration(directory), {
      sessionClock: clock,
    });
    try {
      const call = await signIn(server);
      const structured = {
        title: "Ship release #release 45m @December 1, 2026",
        notes: "",
        structured: true,
      };
      const refused = await call("/api/tasks", "POST", structured, {
        "Idempotency-Key": randomUUID(),
      });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { message: string }).message).toContain(
        "confirm tag creation",
      );
      const created = taskMutationResponseSchema.parse(
        await (
          await call(
            "/api/tasks",
            "POST",
            { ...structured, createTags: true },
            { "Idempotency-Key": randomUUID() },
          )
        ).json(),
      ).task;
      expect(created).toMatchObject({
        title: "Ship release",
        estimateMinutes: 45,
        plannedDay: "2026-12-01",
      });
      expect(created.tagIds).toHaveLength(1);
      const tags = (await (await call("/api/tags", "GET")).json()) as {
        tags: { id: string; displayName: string }[];
      };
      expect(tags.tags.map((tag) => tag.displayName)).toEqual(["release"]);

      // Preview a pasted markdown list: no side effects, new tags reported once.
      const previewed = capturePreviewResponseSchema.parse(
        await (
          await call("/api/tasks/capture-preview", "POST", {
            text: [
              "- [ ] Plan sprint #sprint #release 30m",
              "  - Draft agenda #sprint",
              "  - [x] Book room",
              "- Retro https://example.com/retro",
            ].join("\n"),
            structured: true,
          })
        ).json(),
      );
      expect(previewed).toMatchObject({
        kind: "markdown",
        newTags: ["sprint"],
        skippedCompleted: 1,
        items: [
          {
            title: "Plan sprint",
            estimateMinutes: 30,
            tagTitles: ["release"],
            newTags: ["sprint"],
            children: [
              { title: "Draft agenda", tagTitles: ["sprint"], newTags: [] },
            ],
          },
          {
            title: "Retro https://example.com/retro",
            links: [{ url: "https://example.com/retro" }],
            children: [],
          },
        ],
      });
      expect(tags.tags).toHaveLength(1);
      const batchResponse = await call(
        "/api/tasks/batch",
        "POST",
        { ...previewed.request, createTags: true },
        { "Idempotency-Key": "paste-batch-1" },
      );
      const batchBody: unknown = await batchResponse.json();
      expect(batchResponse.status, JSON.stringify(batchBody)).toBe(201);
      const batch = taskBatchMutationResponseSchema.parse(batchBody);
      expect(batch.replayed).toBe(false);
      expect(batch.tasks.map((task) => task.title)).toEqual([
        "Plan sprint",
        "Draft agenda",
        "Retro https://example.com/retro",
      ]);
      expect(batch.tasks[1]?.parentId).toBe(batch.tasks[0]?.id);
      const replay = await call(
        "/api/tasks/batch",
        "POST",
        { ...previewed.request, createTags: true },
        { "Idempotency-Key": "paste-batch-1" },
      );
      expect(replay.status).toBe(200);
      expect(
        taskBatchMutationResponseSchema.parse(await replay.json()).replayed,
      ).toBe(true);

      // Email text becomes one task with the subject as title.
      const email = capturePreviewResponseSchema.parse(
        await (
          await call("/api/tasks/capture-preview", "POST", {
            text: "From: Ada <ada@example.com>\nSubject: Invoice #42 30m\n\nPlease review.",
            structured: true,
          })
        ).json(),
      );
      expect(email).toMatchObject({
        kind: "email",
        items: [
          {
            title: "Invoice #42 30m",
            notes: "From: Ada <ada@example.com>\n\nPlease review.",
            newTags: [],
            estimateMinutes: null,
          },
        ],
      });

      // Capture preferences with a revision.
      expect(
        capturePreferencesResponseSchema.parse(
          await (await call("/api/capture-preferences", "GET")).json(),
        ),
      ).toEqual({
        preferences: { urlBehavior: "keep_and_attach" },
        revision: 0,
      });
      expect(
        (
          await call("/api/capture-preferences", "PUT", {
            preferences: { urlBehavior: "extract" },
            expectedRevision: 0,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await call("/api/capture-preferences", "PUT", {
            preferences: { urlBehavior: "keep" },
            expectedRevision: 0,
          })
        ).status,
      ).toBe(412);
      const extracted = taskMutationResponseSchema.parse(
        await (
          await call(
            "/api/tasks",
            "POST",
            {
              title: "Read https://example.com/guide",
              notes: "",
              structured: true,
            },
            { "Idempotency-Key": randomUUID() },
          )
        ).json(),
      ).task;
      expect(extracted.title).toBe("Read");
    } finally {
      await server.close();
    }
  });
});

it("lists tags the assistant would create as affected objects and creates them on confirmation", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const clock = new ManualSessionClock("2026-09-19T12:00:00.000Z");
    const server = await startSuiteServer(configuration(directory), {
      sessionClock: clock,
    });
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
      const automation = async (path: string, body: unknown) => {
        const response = await fetch(`${server.baseUrl}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        return {
          status: response.status,
          body: (await response.json()) as unknown,
        };
      };
      const previewResponse = await automation("/api/automation/v1/previews", {
        operation: "tasks.create",
        input: {
          title: "Standup https://example.com/room #Team @every weekday 09:00",
          notes: "",
          structured: true,
        },
      });
      expect(
        previewResponse,
        JSON.stringify(previewResponse.body),
      ).toMatchObject({ status: 201 });
      const preview = automationPreviewResponseSchema.parse(
        previewResponse.body,
      ).preview;
      expect(preview.affected.map((entry) => entry.entityKind)).toEqual([
        "tag",
      ]);
      expect(preview.summary).toContain('creates tag "Team"');
      expect(preview.summary).toContain("attaches 1 link");
      expect(preview.summary).toContain("weekly recurring series");
      const newTagId = preview.affected[0]?.entityId ?? "";
      const confirmed = automationConfirmationResponseSchema.parse(
        (
          await automation(
            `/api/automation/v1/previews/${preview.id}/confirm`,
            {
              idempotencyKey: "capture-standup",
            },
          )
        ).body,
      );
      expect(confirmed.result).toMatchObject({
        task: { title: "Standup https://example.com/room", tagIds: [newTagId] },
      });
      const confirmedTask =
        "task" in confirmed.result ? confirmed.result.task : undefined;
      expect(typeof confirmedTask?.recurrence?.occurrenceDate).toBe("string");
      const tags = (await (await call("/api/tags", "GET")).json()) as {
        tags: { id: string; displayName: string }[];
      };
      expect(tags.tags).toMatchObject([{ id: newTagId, displayName: "Team" }]);

      // A batch previews every item; one name yields one tag.
      const batchPreview = automationPreviewResponseSchema.parse(
        (
          await automation("/api/automation/v1/previews", {
            operation: "tasks.create_many",
            input: {
              items: [
                {
                  title: "Plan #sprint",
                  structured: true,
                  children: [
                    { title: "Agenda #sprint #Team", structured: true },
                  ],
                },
                { title: "Plain item" },
              ],
            },
          })
        ).body,
      ).preview;
      expect(batchPreview.affected).toHaveLength(1);
      expect(batchPreview.summary).toContain(
        "Create 2 tasks with 1 child task",
      );
      const batch = automationConfirmationResponseSchema.parse(
        (
          await automation(
            `/api/automation/v1/previews/${batchPreview.id}/confirm`,
            { idempotencyKey: "capture-batch" },
          )
        ).body,
      );
      expect(batch.result).toMatchObject({
        tasks: [
          { title: "Plan" },
          { title: "Agenda" },
          { title: "Plain item" },
        ],
        replayed: false,
      });
      expect(
        (
          await automation("/api/automation/v1/previews", {
            operation: "tasks.create_many",
            input: {
              items: Array.from({ length: 101 }, () => ({ title: "x" })),
            },
          })
        ).status,
      ).toBe(400);
    } finally {
      await server.close();
    }
  });
});
