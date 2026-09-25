import { join } from "node:path";
import { expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import {
  superProductivityImportLimits as limits,
  sessionResponseSchema,
  superProductivityPreviewSchema,
  taskListResponseSchema,
} from "@suite/contracts";
import { startSuiteServer } from "./server.ts";

it("requires owner authentication and CSRF for a non-mutating task import preview", async () => {
  await withTemporaryDirectory(async (directory) => {
    const server = await startSuiteServer({
      host: "127.0.0.1",
      port: 0,
      databasePath: join(directory, "suite.sqlite"),
      webRoot: directory,
      baikalEndpoint: "http://baikal.test/dav.php/",
      credentialKeyPath: join(directory, "key"),
      secureCookies: false,
      build: { version: "test", revision: "test", builtAt: null },
    });
    try {
      const headers = {
        "Content-Type": "application/json",
        Origin: server.baseUrl,
      };
      const credentials = {
        username: "importer",
        password: "importer-fixture-password",
      };
      const path = `${server.baseUrl}/api/imports/super-productivity/preview`;
      const body = JSON.stringify({
        data: {
          task: {
            ids: ["source-1"],
            entities: { "source-1": { id: "source-1", title: "Source task" } },
          },
        },
      });
      expect(
        (await fetch(path, { method: "POST", headers, body })).status,
      ).toBe(401);
      await fetch(`${server.baseUrl}/api/setup`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...credentials, displayName: "Importer" }),
      });
      const response = await fetch(`${server.baseUrl}/api/auth/login`, {
        method: "POST",
        headers,
        body: JSON.stringify(credentials),
      });
      const session = sessionResponseSchema.parse(await response.json());
      const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
      expect(
        (
          await fetch(path, {
            method: "POST",
            headers: { ...headers, Cookie: cookie },
            body,
          })
        ).status,
      ).toBe(403);
      const authenticated = {
        ...headers,
        Cookie: cookie,
        "X-CSRF-Token": session.csrfToken,
      };
      const preview = await fetch(path, {
        method: "POST",
        headers: authenticated,
        body,
      });
      expect(preview.status).toBe(200);
      const report = superProductivityPreviewSchema.parse(await preview.json());
      expect(report).toMatchObject({ canApply: true, totals: { tasks: 1 } });
      expect(
        (
          await fetch(path, {
            method: "POST",
            headers: authenticated,
            body: "{}",
          })
        ).status,
      ).toBe(400);
      // Import routes accept exports beyond the ordinary API budget, but
      // malformed/oversized preview and apply requests must not mutate state.
      const large = JSON.stringify({
        ...(JSON.parse(body) as Record<string, unknown>),
        ignored: "x".repeat(6 * 1024 * 1024),
      });
      expect(
        (
          await fetch(path, {
            method: "POST",
            headers: authenticated,
            body: large,
          })
        ).status,
      ).toBe(200);
      for (const suffix of ["preview", "apply"]) {
        const rejected = await fetch(path.replace(/preview$/, suffix), {
          method: "POST",
          headers: authenticated,
          body: body + " ".repeat(limits.bytes),
        });
        expect(rejected.status).toBe(413);
        expect(await rejected.json()).toMatchObject({
          code: "BODY_TOO_LARGE",
        });
        expect(
          (
            await fetch(path.replace(/preview$/, suffix), {
              method: "POST",
              headers: authenticated,
              body: "{",
            })
          ).status,
        ).toBe(400);
      }
      const tasks = await fetch(`${server.baseUrl}/api/tasks`, {
        headers: { Cookie: cookie },
      });
      expect(taskListResponseSchema.parse(await tasks.json()).tasks).toEqual(
        [],
      );
      const apply = (hash: string, payload = body) =>
        fetch(path.replace(/preview$/, "apply"), {
          method: "POST",
          headers: { ...authenticated, "X-Import-Hash": hash },
          body: payload,
        });
      expect(
        (
          await fetch(path.replace(/preview$/, "apply"), {
            method: "POST",
            headers,
            body,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(path.replace(/preview$/, "apply"), {
            method: "POST",
            headers: {
              ...headers,
              Cookie: cookie,
              "X-Import-Hash": report.inputHash,
            },
            body,
          })
        ).status,
      ).toBe(403);
      expect((await apply("wrong")).status).toBe(409);
      const applied = await apply(report.inputHash);
      expect(applied.status).toBe(200);
      expect(await applied.json()).toEqual({ created: 1, existing: 0 });
      expect(await (await apply(report.inputHash)).json()).toEqual({
        created: 0,
        existing: 1,
      });
      const unsupported = JSON.stringify({
        task: {
          ids: ["tracked"],
          entities: {
            // A tracked day over 24 hours still blocks (ADR 0024).
            tracked: {
              id: "tracked",
              title: "Tracked",
              timeSpent: 86_400_001,
              timeSpentOnDay: { "2026-09-20": 86_400_001 },
            },
          },
        },
      });
      const blockedPreview = superProductivityPreviewSchema.parse(
        await (
          await fetch(path, {
            method: "POST",
            headers: authenticated,
            body: unsupported,
          })
        ).json(),
      );
      expect(blockedPreview.canApply).toBe(false);
      expect((await apply(blockedPreview.inputHash, unsupported)).status).toBe(
        422,
      );
      const after = taskListResponseSchema.parse(
        await (
          await fetch(`${server.baseUrl}/api/tasks`, {
            headers: { Cookie: cookie },
          })
        ).json(),
      );
      expect(after.tasks).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});
