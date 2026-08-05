import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildResponseSchema,
  healthResponseSchema,
  readinessResponseSchema,
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
        expect(readiness.migrationCount).toBe(1);

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
});
