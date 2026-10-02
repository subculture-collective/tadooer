import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  decodeLiveSyncEvent,
  liveSyncPath,
  liveSyncPushTrigger,
  liveSyncTriggerHeader,
  passwordConfirmationResponseSchema,
  reauthenticationRequiredCode,
  signedInDevicesResponseSchema,
} from "@suite/contracts";
import { SuiteDatabase } from "@suite/persistence";
import { withTemporaryDirectory } from "@suite/test-support";
import { AuthService, deviceLabelFromUserAgent } from "./auth.ts";
import type { ServerConfig } from "./config.ts";
import { ManualLiveSyncTimers } from "./live-sync/manual-timers.ts";
import { sessionPolicy } from "./session-policy.ts";
import {
  startSuiteServer,
  type RunningSuiteServer,
  type SuiteServerOptions,
} from "./server.ts";

/** Trusted-device sessions (ADR 0048, issue #115). */

const minute = 60 * 1000;
const hour = 60 * minute;
const day = 24 * hour;
const password = "a sufficiently long disposable password";
const firefox =
  "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

describe("session policy", () => {
  it("names every lifetime and interval in one place", () => {
    expect(sessionPolicy).toEqual({
      browser: { idleMs: 30 * minute, absoluteMs: 12 * hour },
      trustedDevice: { idleMs: 30 * day, absoluteMs: 180 * day },
      tokenRotationIntervalMs: day,
      tokenRotationOverlapMs: minute,
      tokenReissueAfterMs: hour,
      recentPasswordMs: 15 * minute,
      tokenReuseRecordRetentionMs: 30 * day,
    });
  });

  it("labels a device from its user agent without keeping the agent", () => {
    expect(deviceLabelFromUserAgent(firefox)).toBe("Firefox on Linux");
    expect(
      deviceLabelFromUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Tadooer/0.1.0 Chrome/140.0.0.0 Electron/43.0.0 Safari/537.36",
      ),
    ).toBe("Desktop app on Windows");
    expect(
      deviceLabelFromUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on iOS");
    expect(deviceLabelFromUserAgent(undefined)).toBe("Unknown device");
  });
});

/** An `AuthService` on a clock the test moves. */
const withAuth = async (
  run: (context: {
    readonly auth: AuthService;
    readonly database: SuiteDatabase;
    readonly advance: (milliseconds: number) => void;
    readonly now: () => string;
  }) => Promise<void>,
): Promise<void> => {
  await withTemporaryDirectory(async (directory) => {
    const database = SuiteDatabase.open(join(directory, "suite.sqlite"));
    let clock = Date.parse("2026-10-02T08:00:00.000Z");
    const now = (): string => new Date(clock).toISOString();
    const auth = new AuthService(database, now);
    try {
      await auth.setup({
        username: "owner",
        displayName: "Owner",
        password,
      });
      await run({
        auth,
        database,
        now,
        advance: (milliseconds) => {
          clock += milliseconds;
        },
      });
    } finally {
      database.close();
    }
  });
};

const requestWith = (
  token: string,
  headers: Record<string, string> = {},
  remoteAddress = "127.0.0.1",
) =>
  ({
    headers: { cookie: `suite_session=${token}`, ...headers },
    socket: { remoteAddress },
  }) as never;

const pushHeaders = { [liveSyncTriggerHeader]: liveSyncPushTrigger };
const device = { label: "Laptop", addressFamily: "ipv4" as const };

const trustedLogin = async (auth: AuthService, label = "Laptop") => {
  const session = await auth.login("owner", password, { ...device, label });
  if (session === undefined) throw new Error("Expected a session");
  return session;
};

describe("trusted-device lifetimes", () => {
  it("keeps an ordinary session at 30 idle minutes and 12 hours", async () => {
    await withAuth(async ({ auth, advance }) => {
      const session = await auth.login("owner", password);
      if (session === undefined) throw new Error("Expected a session");
      expect(session.deviceId).toBeNull();
      expect(session.cookie.maxAgeSeconds).toBe(12 * 60 * 60);
      expect(Date.parse(session.expiresAt)).toBe(
        Date.parse("2026-10-02T08:00:00.000Z") + 12 * hour,
      );
      const request = requestWith(session.token);
      // Never rotated, never gated, however old the session is.
      advance(29 * minute);
      expect(auth.rotateDeviceToken(request)).toBeUndefined();
      expect(auth.authenticate(request, true)).toBeDefined();
      advance(29 * minute);
      const active = auth.authenticate(request, false);
      expect(active).toBeDefined();
      if (active === undefined) throw new Error("Expected a session");
      expect(auth.passwordRecentlyConfirmed(active)).toBe(true);
      expect(auth.listDevices(active).devices).toEqual([]);
      advance(minute);
      expect(auth.authenticate(request, false)).toBeUndefined();
    });
  });

  it("ends an ordinary session at 12 hours whatever the activity", async () => {
    await withAuth(async ({ auth, advance }) => {
      const session = await auth.login("owner", password);
      if (session === undefined) throw new Error("Expected a session");
      const request = requestWith(session.token);
      for (let elapsed = 0; elapsed < 12 * hour - 20 * minute;) {
        advance(20 * minute);
        elapsed += 20 * minute;
        expect(auth.authenticate(request, true)).toBeDefined();
      }
      advance(20 * minute);
      expect(auth.authenticate(request, true)).toBeUndefined();
    });
  });

  it("slides the 30-day window on owner activity only", async () => {
    await withAuth(async ({ auth, advance }) => {
      const session = await trustedLogin(auth);
      expect(session.deviceId).not.toBeNull();
      expect(session.cookie.maxAgeSeconds).toBe(180 * 24 * 60 * 60);
      const request = requestWith(session.token);

      // Owner activity on day 29 moves the window to day 59.
      advance(29 * day);
      expect(auth.authenticate(request, true)).toBeDefined();
      advance(29 * day);
      // A read, a hint-triggered request and the stream's check do not.
      expect(auth.authenticate(request, false)).toBeDefined();
      const background = auth.authenticate(
        requestWith(session.token, pushHeaders),
        true,
      );
      expect(background).toBeDefined();
      if (background === undefined) throw new Error("Expected a session");
      expect(auth.sessionActive(background)).toBe(true);
      advance(day - 1);
      expect(auth.authenticate(request, false)).toBeDefined();
      advance(1);
      expect(auth.authenticate(request, false)).toBeUndefined();
      expect(auth.sessionActive(background)).toBe(false);
    });
  });

  it("caps a trusted device at 180 days however often it is used", async () => {
    await withAuth(async ({ auth, database, advance }) => {
      const session = await trustedLogin(auth);
      let token = session.token;
      for (let elapsed = 0; elapsed < 170 * day; elapsed += 10 * day) {
        advance(10 * day);
        const rotated = auth.rotateDeviceToken(requestWith(token));
        if (rotated !== undefined) token = rotated.token;
        expect(auth.authenticate(requestWith(token), true)).toBeDefined();
      }
      const stored = database.deviceSessions.findByDevice(
        session.deviceId ?? "",
      );
      // The idle expiry never passes the absolute one.
      expect(stored?.idleExpiresAt).toBe(session.expiresAt);
      advance(10 * day - 1);
      expect(auth.authenticate(requestWith(token), true)).toBeDefined();
      advance(1);
      expect(auth.authenticate(requestWith(token), true)).toBeUndefined();
    });
  });
});

describe("trusted-device token rotation", () => {
  it("rotates at most once a day, on owner activity, with a cookie to the cap", async () => {
    await withAuth(async ({ auth, advance }) => {
      const session = await trustedLogin(auth);
      const request = requestWith(session.token);
      advance(day - 1);
      expect(auth.rotateDeviceToken(request)).toBeUndefined();
      advance(1);
      // A request caused by a live sync hint never starts a rotation.
      expect(
        auth.rotateDeviceToken(requestWith(session.token, pushHeaders)),
      ).toBeUndefined();
      const rotated = auth.rotateDeviceToken(request);
      expect(rotated?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(rotated?.token).not.toBe(session.token);
      expect(rotated?.maxAgeSeconds).toBe(179 * 24 * 60 * 60);
      if (rotated === undefined) throw new Error("Expected a rotation");

      // The device uses the new token; the next rotation is a day later.
      const next = requestWith(rotated.token);
      expect(auth.authenticate(next, true)?.deviceId).toBe(session.deviceId);
      advance(day - 1);
      expect(auth.rotateDeviceToken(next)).toBeUndefined();
      advance(1);
      expect(auth.rotateDeviceToken(next)).toBeDefined();
    });
  });

  it("keeps concurrent requests of one device signed in across a rotation", async () => {
    await withAuth(async ({ auth, advance }) => {
      const session = await trustedLogin(auth);
      const old = requestWith(session.token);
      advance(day);
      // Five requests leave the device together with the old token. One of
      // them receives the successor; the others are not sent a second one.
      const grants = [1, 2, 3, 4, 5].map(() => auth.rotateDeviceToken(old));
      expect(grants.filter((grant) => grant !== undefined)).toHaveLength(1);
      for (let index = 0; index < 5; index += 1)
        expect(auth.authenticate(old, true)).toBeDefined();
      const successor = grants[0]?.token ?? "";

      // The device stores the successor and uses it, while two requests
      // sent earlier are still on their way with the old token.
      expect(auth.authenticate(requestWith(successor), true)).toBeDefined();
      advance(sessionPolicy.tokenRotationOverlapMs);
      expect(auth.authenticate(old, true)).toBeDefined();
      expect(auth.authenticate(old, false)).toBeDefined();

      // Nothing was revoked.
      const active = auth.authenticate(requestWith(successor), true);
      expect(active).toBeDefined();
      if (active === undefined) throw new Error("Expected a session");
      expect(auth.listDevices(active)).toMatchObject({
        devices: [{ id: session.deviceId, current: true }],
        securityEvents: [],
      });
    });
  });

  it("revokes the device and records the event when a replaced token is replayed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await withAuth(async ({ auth, advance, now }) => {
        const session = await trustedLogin(auth);
        advance(day);
        const rotated = auth.rotateDeviceToken(requestWith(session.token));
        if (rotated === undefined) throw new Error("Expected a rotation");
        const current = requestWith(rotated.token);
        const stream = auth.authenticate(current, true);
        if (stream === undefined) throw new Error("Expected a session");

        // A copy of the old cookie turns up after the overlap window.
        advance(sessionPolicy.tokenRotationOverlapMs + 1);
        const replayedAt = now();
        expect(
          auth.authenticate(requestWith(session.token), false),
        ).toBeUndefined();
        expect(warn).toHaveBeenCalledWith("auth.device.token_reuse_detected");
        // The device session is gone for both holders, and its stream ends.
        expect(auth.authenticate(current, true)).toBeUndefined();
        expect(auth.sessionActive(stream)).toBe(false);

        // The owner sees the event after signing in again, for 30 days.
        const again = await auth.login("owner", password);
        if (again === undefined) throw new Error("Expected a session");
        expect(auth.listDevices(again)).toEqual({
          devices: [],
          securityEvents: [
            {
              deviceId: session.deviceId,
              label: "Laptop",
              kind: "token-reuse",
              occurredAt: replayedAt,
            },
          ],
        });
        advance(sessionPolicy.tokenReuseRecordRetentionMs);
        const later = await auth.login("owner", password);
        if (later === undefined) throw new Error("Expected a session");
        expect(auth.listDevices(later).securityEvents).toEqual([]);
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("does not sign a device out when a rotation response never arrives", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await withAuth(async ({ auth, advance }) => {
      const session = await trustedLogin(auth);
      const old = requestWith(session.token);
      advance(day);
      const lost = auth.rotateDeviceToken(old);
      if (lost === undefined) throw new Error("Expected a rotation");

      // The device never saw the successor and keeps its token for days.
      advance(3 * day);
      expect(auth.authenticate(old, true)).toBeDefined();
      // A later request is sent a new successor; the lost one is retired.
      const second = auth.rotateDeviceToken(old);
      expect(second).toBeDefined();
      expect(second?.token).not.toBe(lost.token);
      if (second === undefined) throw new Error("Expected a rotation");
      expect(auth.authenticate(requestWith(second.token), true)).toBeDefined();

      // The lost successor was never held by the device: using it later is
      // a replay like any other.
      advance(sessionPolicy.tokenRotationOverlapMs + 1);
      expect(auth.authenticate(requestWith(lost.token), false)).toBeUndefined();
      expect(
        auth.authenticate(requestWith(second.token), false),
      ).toBeUndefined();
    }).finally(() => {
      warn.mockRestore();
    });
  });

  it("sends a second successor only after the reissue interval", async () => {
    await withAuth(async ({ auth, advance }) => {
      const session = await trustedLogin(auth);
      const old = requestWith(session.token);
      advance(day);
      expect(auth.rotateDeviceToken(old)).toBeDefined();
      advance(sessionPolicy.tokenReissueAfterMs - 1);
      expect(auth.rotateDeviceToken(old)).toBeUndefined();
      advance(1);
      expect(auth.rotateDeviceToken(old)).toBeDefined();
    });
  });
});

describe("recent-password gate", () => {
  it("asks a trusted device again after 15 minutes and accepts a confirmation", async () => {
    await withAuth(async ({ auth, advance }) => {
      const session = await trustedLogin(auth);
      const request = requestWith(session.token);
      const current = () => {
        const active = auth.authenticate(request, true);
        if (active === undefined) throw new Error("Expected a session");
        return active;
      };
      // Signing in is a password entry.
      advance(15 * minute - 1);
      expect(auth.passwordRecentlyConfirmed(current())).toBe(true);
      advance(1);
      expect(auth.passwordRecentlyConfirmed(current())).toBe(false);

      expect(
        await auth.confirmPassword(current(), "not the owner's password"),
      ).toBeUndefined();
      expect(auth.passwordRecentlyConfirmed(current())).toBe(false);

      const confirmed = await auth.confirmPassword(current(), password);
      expect(
        Date.parse(confirmed?.validUntil ?? "") -
          Date.parse(confirmed?.confirmedAt ?? ""),
      ).toBe(15 * minute);
      expect(auth.passwordRecentlyConfirmed(current())).toBe(true);
      advance(15 * minute);
      expect(auth.passwordRecentlyConfirmed(current())).toBe(false);
    });
  });
});

describe("device registry", () => {
  it("lists, renames and signs out devices, one or all others", async () => {
    await withAuth(async ({ auth, advance, now }) => {
      const laptop = await trustedLogin(auth, "Laptop");
      advance(minute);
      const phone = await trustedLogin(auth, "Phone");
      advance(minute);
      const desktop = await trustedLogin(auth, "Desktop app");
      const browser = await auth.login("owner", password);
      if (browser === undefined) throw new Error("Expected a session");

      // The laptop is used from an IPv6 address a little later.
      advance(minute);
      const seenAt = now();
      const onLaptop = auth.authenticate(
        requestWith(laptop.token, {}, "2001:db8::1"),
        true,
      );
      if (onLaptop === undefined) throw new Error("Expected a session");
      const listed = auth.listDevices(onLaptop);
      expect(listed.securityEvents).toEqual([]);
      expect(listed.devices).toEqual([
        {
          id: laptop.deviceId,
          label: "Laptop",
          createdAt: "2026-10-02T08:00:00.000Z",
          lastSeenAt: seenAt,
          lastAddressFamily: "ipv6",
          expiresAt: new Date(Date.parse(seenAt) + 30 * day).toISOString(),
          current: true,
        },
        expect.objectContaining({
          id: phone.deviceId,
          label: "Phone",
          lastAddressFamily: "ipv4",
          current: false,
        }),
        expect.objectContaining({ id: desktop.deviceId, current: false }),
      ]);
      // Nothing but the family of the address is kept.
      expect(JSON.stringify(listed)).not.toContain("2001:db8");

      expect(auth.renameDevice(onLaptop, phone.deviceId ?? "", "Pixel")).toBe(
        true,
      );
      expect(auth.renameDevice(onLaptop, randomUUID(), "Nothing")).toBe(false);
      expect(auth.listDevices(onLaptop).devices[1]?.label).toBe("Pixel");

      // One device: it loses access on its next request.
      const onPhone = auth.authenticate(requestWith(phone.token), false);
      if (onPhone === undefined) throw new Error("Expected a session");
      expect(auth.revokeDevice(onLaptop, phone.deviceId ?? "")).toBe(true);
      expect(auth.revokeDevice(onLaptop, phone.deviceId ?? "")).toBe(false);
      expect(
        auth.authenticate(requestWith(phone.token), false),
      ).toBeUndefined();
      expect(auth.sessionActive(onPhone)).toBe(false);
      expect(
        auth.authenticate(requestWith(desktop.token), false),
      ).toBeDefined();

      // All others: trusted devices and ordinary browser sessions.
      expect(auth.revokeOtherSessions(onLaptop)).toBe(2);
      expect(
        auth.authenticate(requestWith(desktop.token), false),
      ).toBeUndefined();
      expect(
        auth.authenticate(requestWith(browser.token), false),
      ).toBeUndefined();
      expect(auth.authenticate(requestWith(laptop.token), false)).toBeDefined();
      expect(auth.listDevices(onLaptop).devices).toHaveLength(1);
    });
  });
});

const configuration = (
  directory: string,
  overrides: Partial<ServerConfig> = {},
): ServerConfig => ({
  host: "127.0.0.1",
  port: 0,
  databasePath: join(directory, "suite.sqlite"),
  webRoot: join(directory, "web"),
  baikalEndpoint: "http://baikal.test/dav.php/",
  credentialKeyPath: join(directory, "credential.key"),
  secureCookies: false,
  build: { version: "test", revision: "test", builtAt: null },
  ...overrides,
});

const start = async (
  directory: string,
  options: SuiteServerOptions = {},
  overrides: Partial<ServerConfig> = {},
): Promise<RunningSuiteServer> => {
  await mkdir(join(directory, "web"), { recursive: true });
  return startSuiteServer(configuration(directory, overrides), {
    disableNotificationTimer: true,
    ...options,
  });
};

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One signed-in cookie jar: it stores a rotated cookie like a browser. */
const signIn = async (
  server: RunningSuiteServer,
  username: string,
  trustDevice: boolean,
) => {
  const response = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      Origin: server.baseUrl,
      "Content-Type": "application/json",
      "User-Agent": firefox,
    },
    body: JSON.stringify({ username, password, trustDevice }),
  });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie") ?? "";
  const jar = { cookie: setCookie.split(";", 1)[0] ?? "" };
  const { csrfToken } = (await response.json()) as { csrfToken: string };
  const call = async (
    path: string,
    method: Method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> => {
    const answer = await fetch(`${server.baseUrl}${path}`, {
      method,
      headers: {
        Origin: server.baseUrl,
        Cookie: jar.cookie,
        "X-CSRF-Token": csrfToken,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const rotated = answer.headers.get("set-cookie");
    if (rotated !== null && !rotated.includes("Max-Age=0"))
      jar.cookie = rotated.split(";", 1)[0] ?? jar.cookie;
    return answer;
  };
  return { call, jar, setCookie, csrfToken };
};

const setUp = async (
  server: RunningSuiteServer,
  username: string,
): Promise<void> => {
  const response = await fetch(`${server.baseUrl}/api/setup`, {
    method: "POST",
    headers: { Origin: server.baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ username, displayName: "Owner", password }),
  });
  expect(response.status).toBe(201);
};

const codeOf = async (response: Response): Promise<string | undefined> => {
  const body = (await response.json().catch(() => undefined)) as
    { readonly code?: string } | undefined;
  return body?.code;
};

/** Rewrites session rows the way time would. */
const alter = (directory: string, sql: string, ...values: string[]): void => {
  const database = new DatabaseSync(join(directory, "suite.sqlite"));
  try {
    database.prepare(sql).run(...values);
  } finally {
    database.close();
  }
};

const ago = (milliseconds: number): string =>
  new Date(Date.now() - milliseconds).toISOString();

describe("trusted-device sessions over HTTP", () => {
  it("sets a persistent HttpOnly cookie for a trusted device and leaves the browser cookie as it was", async () => {
    await withTemporaryDirectory(async (directory) => {
      const server = await start(directory);
      try {
        await setUp(server, "cookies");
        const browser = await signIn(server, "cookies", false);
        expect(browser.setCookie).toMatch(
          /^suite_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/,
        );
        const trusted = await signIn(server, "cookies", true);
        expect(trusted.setCookie).toMatch(
          /^suite_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=15552000$/,
        );
        const listed = signedInDevicesResponseSchema.parse(
          await (await trusted.call("/api/auth/devices")).json(),
        );
        expect(listed.devices).toMatchObject([
          {
            label: "Firefox on Linux",
            lastAddressFamily: "ipv4",
            current: true,
          },
        ]);
        // The browser session is not a device and sees the same list.
        const fromBrowser = signedInDevicesResponseSchema.parse(
          await (await browser.call("/api/auth/devices")).json(),
        );
        expect(fromBrowser.devices).toMatchObject([{ current: false }]);
      } finally {
        await server.close();
      }
    });
  });

  it("marks the trusted cookie Secure when the server is configured for it", async () => {
    await withTemporaryDirectory(async (directory) => {
      const server = await start(directory, {}, { secureCookies: true });
      try {
        await setUp(server, "secure");
        const trusted = await signIn(server, "secure", true);
        expect(trusted.setCookie).toMatch(
          /; HttpOnly; SameSite=Strict; Max-Age=15552000; Secure$/,
        );
      } finally {
        await server.close();
      }
    });
  });

  it("rotates the cookie on an owner request, never on a hint-triggered one, and survives a restart", async () => {
    await withTemporaryDirectory(async (directory) => {
      let server = await start(directory);
      try {
        await setUp(server, "rotation");
        const trusted = await signIn(server, "rotation", true);
        const browser = await signIn(server, "rotation", false);
        const first = trusted.jar.cookie;

        // Not due on the first day.
        const early = await trusted.call("/api/tasks");
        expect(early.status).toBe(200);
        expect(early.headers.get("set-cookie")).toBeNull();

        alter(
          directory,
          "UPDATE web_sessions SET token_rotated_at = ? WHERE device_id IS NOT NULL",
          ago(day + minute),
        );
        const background = await trusted.call("/api/tasks", "GET", undefined, {
          [liveSyncTriggerHeader]: liveSyncPushTrigger,
        });
        expect(background.status).toBe(200);
        expect(background.headers.get("set-cookie")).toBeNull();
        expect(
          (await browser.call("/api/tasks")).headers.get("set-cookie"),
        ).toBeNull();

        const rotated = await trusted.call("/api/tasks");
        expect(rotated.status).toBe(200);
        expect(rotated.headers.get("set-cookie")).toMatch(
          /^suite_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/,
        );
        expect(trusted.jar.cookie).not.toBe(first);
        expect((await trusted.call("/api/tasks")).status).toBe(200);

        // Only digests are stored: no row holds a token a device was sent.
        const raw = new DatabaseSync(join(directory, "suite.sqlite"), {
          readOnly: true,
        });
        try {
          const retired = raw
            .prepare("SELECT * FROM web_session_retired_tokens")
            .all();
          expect(retired).toHaveLength(1);
          const stored = JSON.stringify([
            raw.prepare("SELECT * FROM web_sessions").all(),
            retired,
          ]);
          for (const cookie of [first, trusted.jar.cookie, browser.jar.cookie])
            expect(stored).not.toContain(cookie.split("=")[1]);
          expect(stored).not.toContain(trusted.csrfToken);
          expect(stored).not.toContain("127.0.0.1");
        } finally {
          raw.close();
        }

        // The device, its rotated token and the browser session are in the
        // database, not in the process.
        await server.close();
        server = await start(directory);
        const resumed = await fetch(`${server.baseUrl}/api/auth/session`, {
          headers: { Cookie: trusted.jar.cookie },
        });
        expect(resumed.status).toBe(200);
        const devices = signedInDevicesResponseSchema.parse(
          await (
            await fetch(`${server.baseUrl}/api/auth/devices`, {
              headers: { Cookie: trusted.jar.cookie },
            })
          ).json(),
        );
        expect(devices.devices).toMatchObject([
          { label: "Firefox on Linux", current: true },
        ]);

        // The replaced cookie is a replay once the overlap has passed.
        alter(
          directory,
          "UPDATE web_session_retired_tokens SET retired_at = ?",
          ago(2 * minute),
        );
        const replay = await fetch(`${server.baseUrl}/api/tasks`, {
          headers: { Cookie: first },
        });
        expect(replay.status).toBe(401);
        const afterReplay = await fetch(`${server.baseUrl}/api/tasks`, {
          headers: { Cookie: trusted.jar.cookie },
        });
        expect(afterReplay.status).toBe(401);
      } finally {
        await server.close();
      }
    });
  });

  it("requires a recent password on every sensitive route of a trusted device only", async () => {
    await withTemporaryDirectory(async (directory) => {
      const server = await start(directory);
      try {
        await setUp(server, "gated");
        const trusted = await signIn(server, "gated", true);
        await signIn(server, "gated", true);
        const browser = await signIn(server, "gated", false);
        const devices = signedInDevicesResponseSchema.parse(
          await (await trusted.call("/api/auth/devices")).json(),
        );
        const thisDevice =
          devices.devices.find(({ current }) => current)?.id ?? "";
        const token = randomUUID();

        // Method, path and a body that the route itself rejects, so no
        // provider is contacted and nothing is changed while it is tested.
        const sensitive: readonly (readonly [Method, string, unknown?])[] = [
          ["PUT", "/api/connectors/baikal", {}],
          ["POST", "/api/connectors/google/authorize"],
          ["DELETE", "/api/connectors/google/write-consent"],
          ["DELETE", "/api/connectors/google"],
          ["POST", "/api/automation/tokens", {}],
          ["DELETE", `/api/automation/tokens/${token}`],
          ["POST", "/api/calendar-feeds", {}],
          ["GET", "/api/data/export"],
          ["POST", "/api/data/restore/apply", {}],
          ["DELETE", `/api/auth/devices/${randomUUID()}`],
          ["POST", "/api/auth/devices/sign-out-others"],
        ];
        const open: readonly (readonly [Method, string, unknown?])[] = [
          ["GET", "/api/automation/tokens"],
          ["GET", "/api/calendar-feeds"],
          ["GET", "/api/auth/devices"],
          ["POST", "/api/data/restore/preview", {}],
          ["PATCH", `/api/auth/devices/${thisDevice}`, { label: "Mine" }],
          ["POST", "/api/tasks", { title: "Ordinary work is never gated" }],
        ];

        // Signing in was a password entry: nothing is refused yet.
        expect(await codeOf(await trusted.call("/api/data/export"))).not.toBe(
          reauthenticationRequiredCode,
        );

        alter(
          directory,
          "UPDATE web_sessions SET password_confirmed_at = ? WHERE device_id IS NOT NULL",
          ago(16 * minute),
        );
        for (const [method, path, body] of open)
          expect(
            await codeOf(await trusted.call(path, method, body)),
            `${method} ${path}`,
          ).not.toBe(reauthenticationRequiredCode);
        for (const [method, path, body] of sensitive) {
          const refused = await trusted.call(path, method, body);
          expect(refused.status, `${method} ${path}`).toBe(403);
          expect(await codeOf(refused), `${method} ${path}`).toBe(
            reauthenticationRequiredCode,
          );
          // An ordinary browser session is never asked.
          expect(
            await codeOf(await browser.call(path, method, body)),
            `browser ${method} ${path}`,
          ).not.toBe(reauthenticationRequiredCode);
        }

        // The browser session's "sign out others" above ended both trusted
        // devices, so the rest runs on a fresh one.
        expect((await trusted.call("/api/tasks")).status).toBe(401);
        const again = await signIn(server, "gated", true);
        alter(
          directory,
          "UPDATE web_sessions SET password_confirmed_at = ? WHERE device_id IS NOT NULL",
          ago(16 * minute),
        );
        expect(await codeOf(await again.call("/api/data/export"))).toBe(
          reauthenticationRequiredCode,
        );
        const wrong = await again.call("/api/auth/confirm-password", "POST", {
          password: "not the owner's password",
        });
        expect(wrong.status).toBe(403);
        expect(await codeOf(wrong)).toBe("INVALID_CREDENTIALS");
        expect(await codeOf(await again.call("/api/data/export"))).toBe(
          reauthenticationRequiredCode,
        );
        const confirmed = await again.call(
          "/api/auth/confirm-password",
          "POST",
          { password },
        );
        expect(confirmed.status).toBe(200);
        passwordConfirmationResponseSchema.parse(await confirmed.json());
        for (const [method, path, body] of sensitive)
          expect(
            await codeOf(await again.call(path, method, body)),
            `confirmed ${method} ${path}`,
          ).not.toBe(reauthenticationRequiredCode);
      } finally {
        await server.close();
      }
    });
  });

  it("requires the session, the origin and the CSRF token to confirm a password", async () => {
    await withTemporaryDirectory(async (directory) => {
      const server = await start(directory);
      try {
        await setUp(server, "confirm");
        const trusted = await signIn(server, "confirm", true);
        const noCsrf = await trusted.call(
          "/api/auth/confirm-password",
          "POST",
          { password },
          { "X-CSRF-Token": "A".repeat(43) },
        );
        expect(noCsrf.status).toBe(403);
        expect(await codeOf(noCsrf)).toBe("CSRF_INVALID");
        const crossOrigin = await trusted.call(
          "/api/auth/confirm-password",
          "POST",
          { password },
          { Origin: "https://elsewhere.example" },
        );
        expect(crossOrigin.status).toBe(403);
        const signedOut = await fetch(
          `${server.baseUrl}/api/auth/confirm-password`,
          {
            method: "POST",
            headers: {
              Origin: server.baseUrl,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ password }),
          },
        );
        expect(signedOut.status).toBe(403);
      } finally {
        await server.close();
      }
    });
  });

  it("applies the sign-in rate limit and lockout to password confirmation", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await withTemporaryDirectory(async (directory) => {
        const server = await start(directory);
        try {
          await setUp(server, "limited");
          const trusted = await signIn(server, "limited", true);
          for (let attempt = 0; attempt < 5; attempt += 1) {
            const wrong = await trusted.call(
              "/api/auth/confirm-password",
              "POST",
              { password: "not the owner's password" },
            );
            expect(wrong.status).toBe(403);
          }
          // The sixth attempt is refused even with the right password.
          const locked = await trusted.call(
            "/api/auth/confirm-password",
            "POST",
            { password },
          );
          expect(locked.status).toBe(429);
          expect(await codeOf(locked)).toBe("LOGIN_RATE_LIMITED");
          // The lockout is the sign-in lockout: same address and username.
          const login = await fetch(`${server.baseUrl}/api/auth/login`, {
            method: "POST",
            headers: {
              Origin: server.baseUrl,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ username: "limited", password }),
          });
          expect(login.status).toBe(429);
          // The session itself is untouched.
          expect((await trusted.call("/api/tasks")).status).toBe(200);
        } finally {
          await server.close();
        }
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("signs a device out on its next request and closes its live sync stream", async () => {
    await withTemporaryDirectory(async (directory) => {
      const timers = new ManualLiveSyncTimers();
      const server = await start(directory, { liveSyncTimers: timers });
      try {
        await setUp(server, "stream");
        const phone = await signIn(server, "stream", true);
        const laptop = await signIn(server, "stream", true);
        const registration = (await (
          await phone.call("/api/clients", "POST", { label: "Phone" })
        ).json()) as {
          readonly client: { readonly id: string };
          readonly clientCredential: string;
        };
        const stream = await fetch(`${server.baseUrl}${liveSyncPath}`, {
          headers: {
            Cookie: phone.jar.cookie,
            "X-Suite-Client-Id": registration.client.id,
            "X-Suite-Client-Credential": registration.clientCredential,
            "X-Suite-Sync-Version": "2",
          },
        });
        expect(stream.status).toBe(200);
        // The stream never carries a rotated cookie.
        expect(stream.headers.get("set-cookie")).toBeNull();
        const reader = stream.body?.getReader();
        if (reader === undefined) throw new Error("Expected a stream");
        const decoder = new TextDecoder();
        let buffer = "";
        const nextEvent = async () => {
          for (;;) {
            const boundary = buffer.indexOf("\n\n");
            if (boundary !== -1) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const event = decodeLiveSyncEvent(frame);
              if (event !== undefined) return event;
              continue;
            }
            const { done, value } = await reader.read();
            if (done) return undefined;
            buffer += decoder.decode(value, { stream: true });
          }
        };
        expect((await nextEvent())?.event).toBe("hello");

        const devices = signedInDevicesResponseSchema.parse(
          await (await laptop.call("/api/auth/devices")).json(),
        );
        const phoneDevice =
          devices.devices.find(({ current }) => !current)?.id ?? "";
        const revoked = await laptop.call(
          `/api/auth/devices/${phoneDevice}`,
          "DELETE",
        );
        expect(revoked.status).toBe(200);
        expect(await revoked.json()).toEqual({ signedOut: 1 });

        // Within the hub's existing check interval.
        timers.advance(2000);
        expect(await nextEvent()).toEqual({
          event: "bye",
          data: { reason: "session-ended" },
        });
        expect(await nextEvent()).toBeUndefined();
        expect((await phone.call("/api/tasks")).status).toBe(401);
        expect((await laptop.call("/api/tasks")).status).toBe(200);

        // Signing out this device needs no password and clears the cookie.
        alter(
          directory,
          "UPDATE web_sessions SET password_confirmed_at = ? WHERE device_id IS NOT NULL",
          ago(16 * minute),
        );
        const own = signedInDevicesResponseSchema
          .parse(await (await laptop.call("/api/auth/devices")).json())
          .devices.find(({ current }) => current);
        const signedOut = await laptop.call(
          `/api/auth/devices/${own?.id ?? ""}`,
          "DELETE",
        );
        expect(signedOut.status).toBe(200);
        expect(signedOut.headers.get("set-cookie")).toMatch(
          /^suite_session=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0$/,
        );
        expect((await laptop.call("/api/tasks")).status).toBe(401);
      } finally {
        await server.close();
      }
    });
  });

  it("replaces the trusted session of a device that signs in again", async () => {
    await withTemporaryDirectory(async (directory) => {
      const server = await start(directory);
      try {
        await setUp(server, "replace");
        const first = await signIn(server, "replace", true);
        const again = await fetch(`${server.baseUrl}/api/auth/login`, {
          method: "POST",
          headers: {
            Origin: server.baseUrl,
            "Content-Type": "application/json",
            Cookie: first.jar.cookie,
          },
          body: JSON.stringify({
            username: "replace",
            password,
            trustDevice: true,
          }),
        });
        expect(again.status).toBe(200);
        const cookie = again.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
        const devices = signedInDevicesResponseSchema.parse(
          await (
            await fetch(`${server.baseUrl}/api/auth/devices`, {
              headers: { Cookie: cookie },
            })
          ).json(),
        );
        expect(devices.devices).toHaveLength(1);
        expect((await first.call("/api/tasks")).status).toBe(401);
      } finally {
        await server.close();
      }
    });
  });
});
