import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import { startSuiteServer } from "./server.ts";

describe("Phase 8 operations surface", () => {
  it("exposes content-free build, readiness, and Prometheus metrics", async () => {
    await withTemporaryDirectory(async (directory) => {
      await mkdir(join(directory, "web"));
      await writeFile(join(directory, "web", "index.html"), "<h1>Suite</h1>");
      const server = await startSuiteServer({
        host: "127.0.0.1",
        port: 0,
        databasePath: join(directory, "suite.sqlite"),
        webRoot: join(directory, "web"),
        baikalEndpoint: "http://baikal.test/dav.php/",
        credentialKeyPath: join(directory, "key"),
        secureCookies: false,
        build: {
          version: "8.0.0-test",
          revision: "abcdef8",
          builtAt: "2026-08-07T00:00:00.000Z",
        },
      });
      try {
        expect(
          await (await fetch(`${server.baseUrl}/api/build`)).json(),
        ).toMatchObject({ version: "8.0.0-test", revision: "abcdef8" });
        expect(
          await (await fetch(`${server.baseUrl}/api/ready`)).json(),
        ).toMatchObject({ status: "ok", migrationCount: 28 });
        const metricsResponse = await fetch(`${server.baseUrl}/api/metrics`);
        const metrics = await metricsResponse.text();
        expect(metricsResponse.headers.get("content-type")).toContain(
          "text/plain",
        );
        expect(metrics).toContain("suite_uptime_seconds");
        expect(metrics).toContain("suite_database_migrations 28");
        expect(metrics).toContain('suite_http_requests_total{status="200"} 2');
        expect(metrics).not.toContain("owner");
      } finally {
        await server.close();
      }
    });
  });
});
