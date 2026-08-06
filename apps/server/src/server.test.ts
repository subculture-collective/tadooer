import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  buildResponseSchema,
  healthResponseSchema,
  readinessResponseSchema,
  sessionResponseSchema,
  setupStatusResponseSchema,
} from "@suite/contracts";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer } from "./server.ts";

describe("Suite HTTP server", () => {
  it("serves valid health, readiness, build, and web responses", async () => {
    await withTemporaryDirectory(async (directory) => {
      const webRoot = join(directory, "web");
      await mkdir(webRoot);
      await writeFile(join(webRoot, "index.html"), "<h1>Suite shell</h1>");

      const config: ServerConfig = {
        host: "127.0.0.1",
        port: 0,
        databasePath: join(directory, "suite.sqlite"),
        webRoot,
        baikalEndpoint: "http://baikal.test/dav.php/",
        credentialKeyPath: join(directory, "credential.key"),
        secureCookies: false,
        build: {
          version: "0.0.0-test",
          revision: "test-revision",
          builtAt: "2026-08-05T00:00:00.000Z",
        },
      };
      const server = await startSuiteServer(config);

      try {
        const health = await fetch(`${server.baseUrl}/api/health`);
        expect(health.status).toBe(200);
        healthResponseSchema.parse(await health.json());

        const ready = await fetch(`${server.baseUrl}/api/ready`);
        expect(ready.status).toBe(200);
        const readiness = readinessResponseSchema.parse(await ready.json());
        expect(readiness.checks).toEqual({
          database: "ok",
          migrations: "current",
        });
        expect(readiness.migrationCount).toBe(4);

        const build = await fetch(`${server.baseUrl}/api/build`);
        expect(build.status).toBe(200);
        buildResponseSchema.parse(await build.json());

        const shell = await fetch(server.baseUrl);
        expect(await shell.text()).toContain("Suite shell");

        const missingApi = await fetch(`${server.baseUrl}/api/nope`);
        expect(missingApi.status).toBe(404);
      } finally {
        await server.close();
      }
    });
  });

  it("enforces first-run, origin, cookie, CSRF, and logout boundaries", async () => {
    await withTemporaryDirectory(async (directory) => {
      const webRoot = join(directory, "web");
      await mkdir(webRoot);
      await writeFile(join(webRoot, "index.html"), "<h1>Suite shell</h1>");
      const config: ServerConfig = {
        host: "127.0.0.1",
        port: 0,
        databasePath: join(directory, "suite.sqlite"),
        webRoot,
        baikalEndpoint: "http://baikal.test/dav.php/",
        credentialKeyPath: join(directory, "credential.key"),
        secureCookies: false,
        build: { version: "test", revision: "test", builtAt: null },
      };
      const server = await startSuiteServer(config);
      const jsonHeaders = { "Content-Type": "application/json" };

      try {
        const initial = await fetch(`${server.baseUrl}/api/setup/status`);
        expect(setupStatusResponseSchema.parse(await initial.json())).toEqual({
          setupRequired: true,
        });

        const crossOriginSetup = await fetch(`${server.baseUrl}/api/setup`, {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({
            username: "owner",
            displayName: "Owner",
            password: "correct horse battery staple",
          }),
        });
        expect(crossOriginSetup.status).toBe(403);

        const setup = await fetch(`${server.baseUrl}/api/setup`, {
          method: "POST",
          headers: { ...jsonHeaders, Origin: server.baseUrl },
          body: JSON.stringify({
            username: "owner",
            displayName: "Owner",
            password: "correct horse battery staple",
          }),
        });
        expect(setup.status).toBe(201);

        const duplicate = await fetch(`${server.baseUrl}/api/setup`, {
          method: "POST",
          headers: { ...jsonHeaders, Origin: server.baseUrl },
          body: JSON.stringify({
            username: "other",
            displayName: "Other",
            password: "another correct horse password",
          }),
        });
        expect(duplicate.status).toBe(409);

        const login = await fetch(`${server.baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { ...jsonHeaders, Origin: server.baseUrl },
          body: JSON.stringify({
            username: "owner",
            password: "correct horse battery staple",
          }),
        });
        expect(login.status).toBe(200);
        const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
        expect(cookie).toMatch(/^suite_session=/);
        const loggedIn = sessionResponseSchema.parse(await login.json());

        const resumedResponse = await fetch(
          `${server.baseUrl}/api/auth/session`,
          {
            headers: { Cookie: cookie ?? "" },
          },
        );
        expect(resumedResponse.status).toBe(200);
        const resumed = sessionResponseSchema.parse(
          await resumedResponse.json(),
        );
        expect(resumed.owner).toEqual(loggedIn.owner);
        expect(resumed.csrfToken).not.toBe(loggedIn.csrfToken);

        const connector = await fetch(
          `${server.baseUrl}/api/connectors/baikal`,
          {
            headers: { Cookie: cookie ?? "" },
          },
        );
        expect(connector.status).toBe(200);
        expect(await connector.json()).toMatchObject({
          connected: false,
          calendars: [],
        });

        const staleCsrf = await fetch(`${server.baseUrl}/api/auth/logout`, {
          method: "POST",
          headers: {
            Cookie: cookie ?? "",
            Origin: server.baseUrl,
            "X-CSRF-Token": loggedIn.csrfToken,
          },
        });
        expect(staleCsrf.status).toBe(403);
        apiErrorSchema.parse(await staleCsrf.json());

        const logout = await fetch(`${server.baseUrl}/api/auth/logout`, {
          method: "POST",
          headers: {
            Cookie: cookie ?? "",
            Origin: server.baseUrl,
            "X-CSRF-Token": resumed.csrfToken,
          },
        });
        expect(logout.status).toBe(200);

        const revoked = await fetch(`${server.baseUrl}/api/auth/session`, {
          headers: { Cookie: cookie ?? "" },
        });
        expect(revoked.status).toBe(401);
      } finally {
        await server.close();
      }
    });
  });
});
