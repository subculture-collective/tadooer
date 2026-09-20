import { join } from "node:path";
import { expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import { plannerResponseSchema, sessionResponseSchema } from "@suite/contracts";
import { startSuiteServer } from "./server.ts";

it("returns only tasks starting within the half-open Planner period", async () => {
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
        username: "planner",
        password: "planner-fixture-password",
      };
      await fetch(`${server.baseUrl}/api/setup`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...credentials, displayName: "Planner" }),
      });
      const response = await fetch(`${server.baseUrl}/api/auth/login`, {
        method: "POST",
        headers,
        body: JSON.stringify(credentials),
      });
      const session = sessionResponseSchema.parse(await response.json());
      const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
      for (const [title, plannedStart] of [
        ["unscheduled", null],
        ["old", "2026-03-07T23:00:00.000Z"],
        ["start", "2026-03-08T06:00:00.000Z"],
        ["last", "2026-03-09T04:59:59.999Z"],
        ["end", "2026-03-09T05:00:00.000Z"],
      ] as const) {
        const created = await fetch(`${server.baseUrl}/api/tasks`, {
          method: "POST",
          headers: {
            ...headers,
            Cookie: cookie,
            "X-CSRF-Token": session.csrfToken,
            "Idempotency-Key": `planner-test-${title}`,
          },
          body: JSON.stringify({ title, plannedStart }),
        });
        expect(created.status).toBe(201);
      }
      const planner = await fetch(
        `${server.baseUrl}/api/planner?from=2026-03-08T06:00:00.000Z&to=2026-03-09T05:00:00.000Z`,
        { headers: { Cookie: cookie } },
      );
      expect(planner.status).toBe(200);
      expect(
        plannerResponseSchema
          .parse(await planner.json())
          .tasks.map(({ title }) => title),
      ).toEqual(["start", "last"]);
    } finally {
      await server.close();
    }
  });
});
