import { join } from "node:path";
import { expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import {
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
      expect(
        superProductivityPreviewSchema.parse(await preview.json()),
      ).toMatchObject({ canApply: false, totals: { tasks: 1 } });
      expect(
        (
          await fetch(path, {
            method: "POST",
            headers: authenticated,
            body: "{}",
          })
        ).status,
      ).toBe(400);
      const tasks = await fetch(`${server.baseUrl}/api/tasks`, {
        headers: { Cookie: cookie },
      });
      expect(taskListResponseSchema.parse(await tasks.json()).tasks).toEqual(
        [],
      );
    } finally {
      await server.close();
    }
  });
});
