import { expect, it, vi } from "vitest";
import { ApiRequestError, type SessionResponse } from "@suite/contracts";
import {
  startAppBootstrap,
  type AppBootstrapOptions,
} from "./app-bootstrap.ts";

const session: SessionResponse = {
  owner: { id: "owner", username: "owner", displayName: "Owner" },
  csrfToken: "csrf",
  expiresAt: "2026-10-05T00:00:00Z",
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const options = (overrides: Partial<AppBootstrapOptions> = {}) => ({
  setupStatus: vi.fn(() => Promise.resolve({ setupRequired: false })),
  resumeSession: vi.fn(() => Promise.resolve(session)),
  loadAuthenticated: vi.fn(() => Promise.resolve()),
  readOffline: vi.fn(() => Promise.resolve(null)),
  publish: vi.fn(),
  messageFor: () => "Unavailable",
  ...overrides,
});

it("starts setup or resumes a session without reading offline data", async () => {
  const setup = options({
    setupStatus: () => Promise.resolve({ setupRequired: true }),
  });
  await startAppBootstrap(setup).done;
  expect(setup.publish).toHaveBeenCalledWith({ kind: "setup" }, undefined);
  expect(setup.resumeSession).not.toHaveBeenCalled();
  const resume = options();
  await startAppBootstrap(resume).done;
  expect(resume.loadAuthenticated).toHaveBeenCalledWith(
    session,
    expect.any(Function),
  );
  expect(resume.readOffline).not.toHaveBeenCalled();
});

it("uses login for expired sessions and retains cold-offline notes on startup failure", async () => {
  const expired = options({
    resumeSession: () =>
      Promise.reject(new ApiRequestError(401, "EXPIRED", "Expired")),
  });
  await startAppBootstrap(expired).done;
  expect(expired.publish).toHaveBeenCalledWith({ kind: "login" }, undefined);
  expect(expired.readOffline).not.toHaveBeenCalled();
  const offline = options({
    setupStatus: () => Promise.reject(new Error("network")),
    readOffline: () =>
      Promise.resolve({
        kind: "offline",
        tasks: [],
        recovery: [],
        conflictCount: 0,
        message: "Offline",
        cachedNotes: [],
      }),
  });
  await startAppBootstrap(offline).done;
  expect(offline.publish).toHaveBeenCalledWith(
    {
      kind: "offline",
      tasks: [],
      recovery: [],
      conflictCount: 0,
      message: "Offline",
    },
    [],
  );
});

it("does not publish an obsolete offline startup over a replacement startup", async () => {
  const cached =
    deferred<Awaited<ReturnType<AppBootstrapOptions["readOffline"]>>>();
  const reading = deferred<undefined>();
  const old = options({
    setupStatus: () => Promise.reject(new Error("offline")),
    readOffline: () => {
      reading.resolve(undefined);
      return cached.promise;
    },
  });
  const startup = startAppBootstrap(old);
  await reading.promise;
  startup.cancel();
  const fresh = options();
  await startAppBootstrap(fresh).done;
  cached.resolve({ kind: "error", message: "Obsolete" });
  await startup.done;
  expect(old.publish).not.toHaveBeenCalled();
  expect(fresh.loadAuthenticated).toHaveBeenCalledOnce();
});

it("invalidates authenticated loading on cleanup, including StrictMode replacement", async () => {
  const loading = deferred<undefined>();
  const finish = deferred<undefined>();
  const publish = vi.fn();
  const startup = startAppBootstrap(
    options({
      loadAuthenticated: async (_session, isCurrent) => {
        loading.resolve(undefined);
        await finish.promise;
        if (isCurrent()) publish();
      },
    }),
  );
  await loading.promise;
  startup.cancel();
  finish.resolve(undefined);
  await startup.done;
  expect(publish).not.toHaveBeenCalled();
});
