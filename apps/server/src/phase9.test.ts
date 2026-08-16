import { mkdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import { startSuiteServer } from "./server.ts";

describe("Phase 9 production trust boundary", () => {
  it("enforces the public host/origin and trusts forwarding only from Almaz", async () => {
    await withTemporaryDirectory(async (directory) => {
      const webRoot = join(directory, "web");
      await mkdir(webRoot);
      await writeFile(join(webRoot, "index.html"), "<h1>Suite</h1>");
      const server = await startSuiteServer({
        host: "127.0.0.1",
        port: 0,
        databasePath: join(directory, "suite.sqlite"),
        webRoot,
        baikalEndpoint: "http://baikal.test/dav.php/",
        credentialKeyPath: join(directory, "credential.key"),
        secureCookies: true,
        publicOrigin: "https://tadooer.subcult.tv",
        trustedProxyCidrs: ["127.0.0.1/32"],
        build: { version: "9.0.0-test", revision: "phase9", builtAt: null },
      });
      const expectedHeaders = { Host: "tadooer.subcult.tv" };
      const call = (
        path: string,
        options: {
          readonly method?: string;
          readonly headers?: Readonly<Record<string, string>>;
          readonly body?: string;
        } = {},
      ) =>
        new Promise<{
          status: number;
          headers: Readonly<
            Record<string, string | readonly string[] | undefined>
          >;
        }>((resolveCall, rejectCall) => {
          const target = new URL(server.baseUrl);
          const outgoing = request(
            {
              hostname: target.hostname,
              port: target.port,
              path,
              method: options.method ?? "GET",
              headers: options.headers,
            },
            (incoming) => {
              incoming.resume();
              incoming.once("end", () =>
                resolveCall({
                  status: incoming.statusCode ?? 0,
                  headers: incoming.headers,
                }),
              );
            },
          );
          outgoing.once("error", rejectCall);
          if (options.body !== undefined) outgoing.write(options.body);
          outgoing.end();
        });
      const login = (forwardedFor: string) =>
        call("/api/auth/login", {
          method: "POST",
          headers: {
            ...expectedHeaders,
            Origin: "https://tadooer.subcult.tv",
            "Content-Type": "application/json",
            "X-Forwarded-For": forwardedFor,
          },
          body: JSON.stringify({ username: "owner", password: "invalid" }),
        });
      try {
        const wrongHost = await call("/api/health");
        expect(wrongHost.status).toBe(421);

        const wrongOrigin = await call("/api/setup", {
          method: "POST",
          headers: {
            ...expectedHeaders,
            Origin: "https://attacker.example",
            "Content-Type": "application/json",
          },
          body: "{}",
        });
        expect(wrongOrigin.status).toBe(403);

        const health = await call("/api/health", {
          headers: expectedHeaders,
        });
        expect(health.status).toBe(200);
        expect(health.headers["strict-transport-security"]).toContain(
          "max-age=31536000",
        );

        const privatePortHealth = await call("/api/health", {
          headers: { Host: "tadooer.subcult.tv:8080" },
        });
        expect(privatePortHealth.status).toBe(200);

        const credentialLikeHost = await call("/api/health", {
          headers: { Host: "attacker@tadooer.subcult.tv" },
        });
        expect(credentialLikeHost.status).toBe(421);

        for (let index = 1; index <= 6; index += 1)
          expect((await login(`192.0.2.${String(index)}`)).status).toBe(401);
        for (let index = 0; index < 5; index += 1)
          expect((await login("198.51.100.10")).status).toBe(401);
        expect((await login("198.51.100.10")).status).toBe(429);
      } finally {
        await server.close();
      }
    });
  });
});
