import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  automationConfirmationResponseSchema,
  automationPreviewResponseSchema,
  automationTokenScopeSchema,
  createAutomationTokenResponseSchema,
  noteListResponseSchema,
  noteResponseSchema,
  projectSchema,
  tagSchema,
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
    username: "organizer",
    displayName: "Organizer",
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
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { browser };
};

it("serves project/tag lifecycle, order, backlog and notes over the browser API", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const config = configuration(directory);
    let server = await startSuiteServer(config);
    try {
      let { browser } = await signIn(server);
      const project = async (title: string) =>
        projectSchema.parse(
          (
            (await (
              await browser("/api/projects", "POST", { title })
            ).json()) as {
              project: unknown;
            }
          ).project,
        );
      const a = await project("Alpha");
      const b = await project("Beta");
      expect([a.position, b.position]).toEqual([0, 1]);
      // Appearance and completion; the old browser restriction on unarchive is gone.
      const styled = await browser(
        `/api/projects/${a.id}`,
        "PATCH",
        { color: "#AA00FF", icon: "work", hiddenFromMenu: true },
        1,
      );
      expect(styled.status).toBe(200);
      expect(
        (
          await browser(
            `/api/projects/${a.id}`,
            "PATCH",
            { icon: "<img src=x>" },
            2,
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await browser(
            `/api/projects/${a.id}`,
            "PATCH",
            { archived: true, completed: true },
            2,
          )
        ).status,
      ).toBe(400);
      const completed = (await (
        await browser(`/api/projects/${a.id}`, "PATCH", { completed: true }, 2)
      ).json()) as { project: unknown };
      expect(projectSchema.parse(completed.project)).toMatchObject({
        color: "#aa00ff",
        icon: "work",
        hiddenFromMenu: true,
        revision: 3,
      });
      const restored = (await (
        await browser(`/api/projects/${a.id}`, "PATCH", { archived: false }, 3)
      ).json()) as { project: unknown };
      expect(projectSchema.parse(restored.project)).toMatchObject({
        archivedAt: null,
        completedAt: null,
        revision: 4,
      });
      // Reorder: stale revisions conflict, complete membership succeeds.
      expect(
        (
          await browser("/api/projects/order", "PUT", {
            items: [
              { id: b.id, revision: 1 },
              { id: a.id, revision: 3 },
            ],
          })
        ).status,
      ).toBe(412);
      const reordered = (await (
        await browser("/api/projects/order", "PUT", {
          items: [
            { id: b.id, revision: 1 },
            { id: a.id, revision: 4 },
          ],
        })
      ).json()) as { projects: { id: string }[] };
      expect(reordered.projects.map(({ id }) => id)).toEqual([b.id, a.id]);
      const tag = tagSchema.parse(
        (
          (await (
            await browser("/api/tags", "POST", { title: "Deep" })
          ).json()) as {
            tag: unknown;
          }
        ).tag,
      );
      expect(
        (await browser(`/api/tags/${tag.id}`, "PATCH", { completed: true }, 1))
          .status,
      ).toBe(400);
      expect(
        await (
          await browser(
            `/api/tags/${tag.id}`,
            "PATCH",
            { color: "#123456", icon: "🌊" },
            1,
          )
        ).json(),
      ).toMatchObject({ tag: { color: "#123456", icon: "🌊", revision: 2 } });
      // Backlog: enable, move in, move out.
      const created = (await (
        await browser("/api/tasks", "POST", { title: "Someday" }, undefined, {
          "Idempotency-Key": randomUUID(),
        })
      ).json()) as { task: { id: string; revision: number } };
      const taskId = created.task.id;
      await browser(
        `/api/tasks/${taskId}/project`,
        "PUT",
        { projectId: b.id },
        created.task.revision,
      );
      expect(
        (
          await browser(
            `/api/projects/${b.id}/backlog`,
            "PUT",
            { taskId, inBacklog: true },
            2,
          )
        ).status,
      ).toBe(409);
      await browser(
        `/api/projects/${b.id}`,
        "PATCH",
        { backlogEnabled: true },
        2,
      );
      const backlog = (await (
        await browser(
          `/api/projects/${b.id}/backlog`,
          "PUT",
          { taskId, inBacklog: true },
          3,
        )
      ).json()) as { project: unknown };
      expect(projectSchema.parse(backlog.project)).toMatchObject({
        backlogTaskIds: [taskId],
        revision: 4,
      });
      expect(
        (
          await browser(
            `/api/projects/${b.id}/backlog`,
            "PUT",
            { taskId, inBacklog: false },
            3,
          )
        ).status,
      ).toBe(412);
      // Notes: create, edit, reorder, delete with revisions.
      const note = noteResponseSchema.parse(
        await (
          await browser("/api/notes", "POST", {
            content:
              "Read <script>alert(1)</script> [docs](https://example.com)",
            projectId: b.id,
            pinnedToToday: true,
          })
        ).json(),
      ).note;
      expect(note).toMatchObject({
        projectId: b.id,
        pinnedToToday: true,
        revision: 1,
      });
      expect(
        (
          await browser("/api/notes", "POST", {
            content: "x",
            projectId: b.id,
            tagId: tag.id,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await browser("/api/notes", "POST", {
            content: "x",
            projectId: randomUUID(),
          })
        ).status,
      ).toBe(400);
      const second = noteResponseSchema.parse(
        await (
          await browser("/api/notes", "POST", { content: "Standalone" })
        ).json(),
      ).note;
      const edited = await browser(
        `/api/notes/${note.id}`,
        "PATCH",
        { tagId: tag.id },
        1,
      );
      expect(noteResponseSchema.parse(await edited.json()).note).toMatchObject({
        projectId: null,
        tagId: tag.id,
        revision: 2,
      });
      expect(
        (
          await browser(
            `/api/notes/${note.id}`,
            "PATCH",
            { content: "stale" },
            1,
          )
        ).status,
      ).toBe(412);
      expect((await browser(`/api/notes/${note.id}`, "DELETE")).status).toBe(
        428,
      );
      const ordered = noteListResponseSchema.parse(
        await (
          await browser("/api/notes/order", "PUT", {
            items: [
              { id: second.id, revision: 1 },
              { id: note.id, revision: 2 },
            ],
          })
        ).json(),
      );
      expect(ordered.notes.map(({ id }) => id)).toEqual([second.id, note.id]);
      // The project change feed carries the new fields; notes stay out of it.
      await server.close();
      server = await startSuiteServer(config);
      ({ browser } = await signIn(server));
      const notes = noteListResponseSchema.parse(
        await (await browser("/api/notes")).json(),
      ).notes;
      expect(notes.map(({ id }) => id)).toEqual([second.id, note.id]);
      const target = notes[0];
      if (target === undefined) throw new Error("note missing");
      expect(
        (
          await browser(
            `/api/notes/${target.id}`,
            "DELETE",
            undefined,
            target.revision,
          )
        ).status,
      ).toBe(204);
      expect(
        noteListResponseSchema.parse(await (await browser("/api/notes")).json())
          .notes,
      ).toHaveLength(1);
      const projects = (await (await browser("/api/projects")).json()) as {
        projects: unknown[];
      };
      expect(
        projects.projects.map((value) => projectSchema.parse(value)),
      ).toMatchObject([
        { id: b.id, backlogTaskIds: [taskId], backlogEnabled: true },
        { id: a.id, color: "#aa00ff" },
      ]);
      // Anonymous and cross-site requests are refused.
      expect((await fetch(`${server.baseUrl}/api/notes`)).status).toBe(401);
    } finally {
      await server.close();
    }
  });
});

it("previews and confirms organization parity operations with scopes, stale guards and replay", async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(join(directory, "web"));
    const config = configuration(directory);
    let server = await startSuiteServer(config);
    try {
      const { browser } = await signIn(server);
      const issue = async (scopes: string[]) =>
        createAutomationTokenResponseSchema.parse(
          await (
            await browser("/api/automation/tokens", "POST", {
              label: "Organizer",
              scopes,
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
            })
          ).json(),
        ).token;
      const token = await issue([...automationTokenScopeSchema.options]);
      const noNotes = await issue([
        "projects:read",
        "projects:write",
        "tags:write",
      ]);
      const automation = (
        path: string,
        method: "GET" | "POST",
        body?: unknown,
        credential = token,
      ) =>
        fetch(`${server.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${credential}`,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const previewRequest = (
        operation: string,
        input: unknown,
        credential = token,
      ) =>
        automation(
          "/api/automation/v1/previews",
          "POST",
          { operation, input },
          credential,
        );
      const preview = async (operation: string, input: unknown) => {
        const response = await previewRequest(operation, input);
        expect(response.status, operation).toBe(201);
        return automationPreviewResponseSchema.parse(await response.json())
          .preview;
      };
      const confirm = (id: string, key = randomUUID()) =>
        automation(`/api/automation/v1/previews/${id}/confirm`, "POST", {
          idempotencyKey: key,
        });
      const apply = async (operation: string, input: unknown) => {
        const p = await preview(operation, input);
        const response = await confirm(p.id);
        expect(response.status, operation).toBe(200);
        return automationConfirmationResponseSchema.parse(
          await response.json(),
        );
      };
      const [p1, p2] = [randomUUID(), randomUUID()];
      await apply("projects.mutate", {
        action: "create",
        id: p1,
        title: "One",
      });
      await apply("projects.mutate", {
        action: "create",
        id: p2,
        title: "Two",
      });
      const completedPreview = await preview("projects.mutate", {
        action: "complete",
        id: p1,
        expectedRevision: 1,
      });
      expect(completedPreview.summary).toContain("Complete and archive");
      const completed = automationConfirmationResponseSchema.parse(
        await (await confirm(completedPreview.id)).json(),
      );
      expect(completed.result).toMatchObject({ project: { revision: 2 } });
      expect(
        (
          await apply("projects.mutate", {
            action: "reopen",
            id: p1,
            expectedRevision: 2,
          })
        ).result,
      ).toMatchObject({
        project: { completedAt: null, archivedAt: null, revision: 3 },
      });
      expect(
        (
          await apply("projects.mutate", {
            action: "configure",
            id: p1,
            expectedRevision: 3,
            color: "#00ff00",
            backlogEnabled: true,
          })
        ).result,
      ).toMatchObject({
        project: { color: "#00ff00", backlogEnabled: true, revision: 4 },
      });
      expect(
        (
          await previewRequest("projects.mutate", {
            action: "configure",
            id: p1,
            expectedRevision: 4,
          })
        ).status,
      ).toBe(400);
      // Reorder freezes every revision; a later edit makes the preview stale.
      const order = await preview("projects.reorder", {
        items: [
          { id: p2, revision: 1 },
          { id: p1, revision: 4 },
        ],
      });
      expect(order.summary).toContain('"Two", "One"');
      expect(
        (
          await previewRequest("projects.reorder", {
            items: [{ id: p2, revision: 1 }],
          })
        ).status,
      ).toBe(412);
      await apply("projects.mutate", {
        action: "rename",
        id: p2,
        expectedRevision: 1,
        title: "Second",
      });
      expect((await confirm(order.id)).status).toBe(412);
      const reordered = await apply("projects.reorder", {
        items: [
          { id: p2, revision: 2 },
          { id: p1, revision: 4 },
        ],
      });
      expect(reordered.result).toMatchObject({
        projects: [
          { id: p2, position: 0 },
          { id: p1, position: 1 },
        ],
      });
      // Backlog through a task of the project.
      const task = await apply("tasks.create", { title: "Parked" });
      if (!("task" in task.result)) throw new Error("task expected");
      const taskId = task.result.task.id;
      await apply("tasks.assign_project", {
        taskId,
        expectedRevision: 1,
        projectId: p1,
      });
      expect(
        (
          await previewRequest("projects.set_backlog", {
            projectId: p2,
            expectedRevision: 3,
            taskId,
            inBacklog: true,
          })
        ).status,
      ).toBe(409);
      const backlogged = await apply("projects.set_backlog", {
        projectId: p1,
        expectedRevision: 5,
        taskId,
        inBacklog: true,
      });
      expect(backlogged.result).toMatchObject({
        project: { backlogTaskIds: [taskId], revision: 6 },
      });
      // Notes need their own scopes; create/update/reorder/delete with replay.
      const noteId = randomUUID();
      expect(
        (
          await previewRequest(
            "notes.mutate",
            { action: "create", id: noteId, content: "Hi" },
            noNotes,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await automation(
            "/api/automation/v1/resources/notes",
            "GET",
            undefined,
            noNotes,
          )
        ).status,
      ).toBe(403);
      const createNote = await preview("notes.mutate", {
        action: "create",
        id: noteId,
        content: "Plan **launch**",
        projectId: p1,
      });
      const key = randomUUID();
      const createdNote = automationConfirmationResponseSchema.parse(
        await (await confirm(createNote.id, key)).json(),
      );
      expect(createdNote.result).toMatchObject({
        notes: [{ id: noteId, projectId: p1, revision: 1 }],
        deletedIds: [],
      });
      await server.close();
      server = await startSuiteServer(config);
      expect(
        automationConfirmationResponseSchema.parse(
          await (await confirm(createNote.id, key)).json(),
        ),
      ).toEqual({ ...createdNote, replayed: true });
      expect(
        (
          await previewRequest("notes.mutate", {
            action: "create",
            id: noteId,
            content: "Again",
          })
        ).status,
      ).toBe(412);
      const staleEdit = await preview("notes.mutate", {
        action: "update",
        id: noteId,
        expectedRevision: 1,
        patch: { pinnedToToday: true },
      });
      await apply("notes.mutate", {
        action: "update",
        id: noteId,
        expectedRevision: 1,
        patch: { content: "Changed" },
      });
      expect((await confirm(staleEdit.id)).status).toBe(412);
      const deletion = await preview("notes.mutate", {
        action: "delete",
        id: noteId,
        expectedRevision: 2,
      });
      expect(deletion.summary).toContain("Permanently delete");
      expect(
        (
          await apply("notes.mutate", {
            action: "delete",
            id: noteId,
            expectedRevision: 2,
          })
        ).result,
      ).toMatchObject({
        notes: [],
        deletedIds: [noteId],
      });
      expect((await confirm(deletion.id)).status).toBe(412);
      expect(
        noteListResponseSchema.parse(
          await (
            await automation("/api/automation/v1/resources/notes", "GET")
          ).json(),
        ),
      ).toEqual({ notes: [] });
    } finally {
      await server.close();
    }
  });
});
