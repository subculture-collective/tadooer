import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  baikalProbeResponseSchema,
  baikalStatusResponseSchema,
} from "@suite/contracts";
import {
  baikalOwnerPrivileges,
  createCalDavFake,
  withTemporaryDirectory,
  type CalDavFake,
} from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { startSuiteServer } from "./server.ts";

const davUser = "tadooer";
const davPassword = "dav-password-that-must-not-leak";

const configFor = async (
  directory: string,
  baikalEndpoint = "http://baikal.test/dav.php/",
): Promise<ServerConfig> => {
  const webRoot = join(directory, "web");
  await mkdir(webRoot, { recursive: true });
  await writeFile(join(webRoot, "index.html"), "<h1>Suite</h1>");
  return {
    host: "127.0.0.1",
    port: 0,
    databasePath: join(directory, "suite.sqlite"),
    webRoot,
    baikalEndpoint,
    credentialKeyPath: join(directory, "credential.key"),
    secureCookies: false,
    build: { version: "test", revision: "adr-0039", builtAt: null },
  };
};

const signIn = async (
  baseUrl: string,
  create: boolean,
): Promise<{ readonly cookie: string; readonly csrf: string }> => {
  const headers = { "Content-Type": "application/json", Origin: baseUrl };
  const credentials = {
    username: "owner",
    password: "correct horse battery staple",
  };
  if (create)
    expect(
      (
        await fetch(`${baseUrl}/api/setup`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...credentials, displayName: "Owner" }),
        })
      ).status,
    ).toBe(201);
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers,
    body: JSON.stringify(credentials),
  });
  const body = (await login.json()) as { readonly csrfToken: string };
  return {
    cookie: login.headers.get("set-cookie")?.split(";", 1)[0] ?? "",
    csrf: body.csrfToken,
  };
};

const davCall = (
  baseUrl: string,
  session: { readonly cookie: string; readonly csrf: string },
  path: "/api/connectors/baikal/probe" | "/api/connectors/baikal",
  method: "POST" | "PUT",
  password = davPassword,
  csrf = true,
) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: baseUrl,
      Cookie: session.cookie,
      ...(csrf ? { "X-CSRF-Token": session.csrf } : {}),
    },
    body: JSON.stringify({ username: davUser, password }),
  });

const expectFailure = async (
  response: Response,
  status: number,
  code: string,
): Promise<string> => {
  const text = await response.text();
  expect(response.status).toBe(status);
  const error = apiErrorSchema.parse(JSON.parse(text));
  expect(error.code).toBe(code);
  expect(text).not.toContain(davPassword);
  expect(error.message).not.toContain(davUser);
  return error.message;
};

describe("Baikal setup qualification routes (ADR 0039)", () => {
  it("probes capability and per-calendar permissions without storing anything", async () => {
    await withTemporaryDirectory(async (directory) => {
      const fake = createCalDavFake({
        username: davUser,
        password: davPassword,
        calendars: [
          {
            name: "default",
            displayName: "Default calendar",
            components: ["VEVENT", "VTODO"],
            privileges: baikalOwnerPrivileges,
          },
          {
            name: "team",
            displayName: "Team (shared)",
            components: ["VEVENT"],
            privileges: ["d:read", "cal:read-free-busy"],
          },
          {
            name: "restricted",
            displayName: "Restricted",
            components: ["VEVENT"],
            privileges: "forbidden",
          },
        ],
      });
      const server = await startSuiteServer(await configFor(directory), {
        connectorFetch: fake.fetch,
      });
      try {
        const session = await signIn(server.baseUrl, true);
        expect(
          (
            await davCall(
              server.baseUrl,
              session,
              "/api/connectors/baikal/probe",
              "POST",
              davPassword,
              false,
            )
          ).status,
        ).toBe(403);

        const response = await davCall(
          server.baseUrl,
          session,
          "/api/connectors/baikal/probe",
          "POST",
        );
        const text = await response.text();
        expect(response.status).toBe(200);
        expect(text).not.toContain(davPassword);
        const probe = baikalProbeResponseSchema.parse(JSON.parse(text));
        expect(probe.davClasses).toContain("calendar-access");
        expect(probe.calendarHomeHref).toBe(`/dav.php/calendars/${davUser}/`);
        expect(
          probe.calendars.map((calendar) => [
            calendar.displayName,
            calendar.canRead,
            calendar.canWrite,
          ]),
        ).toEqual([
          ["Default calendar", true, true],
          ["Team (shared)", true, false],
          ["Restricted", false, false],
        ]);
        expect(probe.writableEventCalendars).toBe(1);
        expect(
          fake.requests.every((request) => request.redirect === "manual"),
        ).toBe(true);

        const status = baikalStatusResponseSchema.parse(
          await (
            await fetch(`${server.baseUrl}/api/connectors/baikal`, {
              headers: { Cookie: session.cookie },
            })
          ).json(),
        );
        expect(status.connected).toBe(false);
      } finally {
        await server.close();
      }
      expect(
        (await readFile(join(directory, "suite.sqlite"))).includes(davPassword),
      ).toBe(false);
    });
  });

  it("gives one actionable, credential-free message per setup failure", async () => {
    await withTemporaryDirectory(async (directory) => {
      let current: CalDavFake = createCalDavFake({
        username: davUser,
        password: davPassword,
      });
      const server = await startSuiteServer(await configFor(directory), {
        connectorFetch: (input, init) => current.fetch(input, init),
      });
      const cases: readonly {
        readonly fake: CalDavFake;
        readonly password?: string;
        /** Connect is discovery-only; the OPTIONS capability check is probe-only. */
        readonly probeOnly?: boolean;
        readonly status: number;
        readonly code: string;
        readonly hint: RegExp;
      }[] = [
        {
          fake: createCalDavFake({ username: davUser, password: davPassword }),
          password: "not-the-dav-password",
          status: 401,
          code: "BAIKAL_AUTHENTICATION_FAILED",
          hint: /admin account cannot sign in/,
        },
        {
          fake: createCalDavFake({
            username: davUser,
            password: davPassword,
            davHeader: "1, 2, 3",
          }),
          probeOnly: true,
          status: 502,
          code: "BAIKAL_CALDAV_DISABLED",
          hint: /Enable CalDAV/,
        },
        {
          fake: createCalDavFake({
            username: davUser,
            password: davPassword,
            override: () =>
              new Response(null, {
                status: 302,
                headers: { Location: "https://baikal.test/dav.php/" },
              }),
          }),
          status: 502,
          code: "BAIKAL_REDIRECTED",
          hint: /does not follow/,
        },
        {
          fake: createCalDavFake({
            username: davUser,
            password: davPassword,
            override: () =>
              new Response("<html>Not Allowed</html>", { status: 405 }),
          }),
          status: 502,
          code: "BAIKAL_NOT_CALDAV",
          hint: /not the admin interface/,
        },
        {
          fake: createCalDavFake({
            username: davUser,
            password: davPassword,
            origin: "http://elsewhere.test",
          }),
          status: 502,
          code: "BAIKAL_UNREACHABLE",
          hint: /NODE_EXTRA_CA_CERTS/,
        },
        {
          fake: createCalDavFake({
            username: davUser,
            password: davPassword,
            override: (method) =>
              method === "PROPFIND"
                ? new Response("", { status: 503 })
                : undefined,
          }),
          status: 502,
          code: "BAIKAL_SERVER_ERROR",
          hint: /healthy/,
        },
      ];
      try {
        const session = await signIn(server.baseUrl, true);
        for (const failure of cases) {
          current = failure.fake;
          const routes: readonly (readonly [
            "/api/connectors/baikal/probe" | "/api/connectors/baikal",
            "POST" | "PUT",
          ])[] =
            failure.probeOnly === true
              ? [["/api/connectors/baikal/probe", "POST"]]
              : [
                  ["/api/connectors/baikal/probe", "POST"],
                  ["/api/connectors/baikal", "PUT"],
                ];
          for (const [path, method] of routes) {
            const message = await expectFailure(
              await davCall(
                server.baseUrl,
                session,
                path,
                method,
                failure.password,
              ),
              failure.status,
              failure.code,
            );
            expect(message).toMatch(failure.hint);
          }
        }
      } finally {
        await server.close();
      }
    });
  });

  it("reports revocation and endpoint changes as reconnect steps", async () => {
    await withTemporaryDirectory(async (directory) => {
      const fake = createCalDavFake({
        username: davUser,
        password: davPassword,
      });
      const first = await startSuiteServer(await configFor(directory), {
        connectorFetch: fake.fetch,
      });
      try {
        const session = await signIn(first.baseUrl, true);
        const connected = await davCall(
          first.baseUrl,
          session,
          "/api/connectors/baikal",
          "PUT",
        );
        expect(connected.status).toBe(200);
        fake.revoke();
        await expectFailure(
          await fetch(`${first.baseUrl}/api/connectors/baikal`, {
            headers: { Cookie: session.cookie },
          }),
          401,
          "BAIKAL_AUTHENTICATION_FAILED",
        );
      } finally {
        await first.close();
      }

      const moved = createCalDavFake({
        origin: "http://baikal-bundled",
        username: davUser,
        password: davPassword,
      });
      const second = await startSuiteServer(
        await configFor(directory, "http://baikal-bundled/dav.php/"),
        { connectorFetch: moved.fetch },
      );
      try {
        const session = await signIn(second.baseUrl, false);
        const message = await expectFailure(
          await fetch(`${second.baseUrl}/api/connectors/baikal`, {
            headers: { Cookie: session.cookie },
          }),
          409,
          "BAIKAL_RECONNECT_REQUIRED",
        );
        expect(message).toMatch(/Connect again/);
        expect(
          (
            await davCall(
              second.baseUrl,
              session,
              "/api/connectors/baikal",
              "PUT",
            )
          ).status,
        ).toBe(200);
        expect(moved.requests).not.toHaveLength(0);
      } finally {
        await second.close();
      }
    });
  });
});
