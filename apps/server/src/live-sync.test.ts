import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  automationConfirmationResponseSchema,
  automationPreviewResponseSchema,
  automationTokenScopeSchema,
  clientRegistrationResponseSchema,
  createAutomationTokenResponseSchema,
  decodeLiveSyncEvent,
  liveSyncHeartbeatSeconds,
  liveSyncPath,
  syncRoundResponseSchema,
  type LiveSyncEvent,
} from "@suite/contracts";
import { SuiteDatabase } from "@suite/persistence";
import { withTemporaryDirectory } from "@suite/test-support";
import type { ServerConfig } from "./config.ts";
import { ManualLiveSyncTimers } from "./live-sync/manual-timers.ts";
import {
  startSuiteServer,
  type RunningSuiteServer,
  type SuiteServerOptions,
} from "./server.ts";

/** Live sync hint stream over real HTTP (ADR 0045, issue #113). */

const configuration = (directory: string): ServerConfig => ({
  host: "127.0.0.1",
  port: 0,
  databasePath: join(directory, "suite.sqlite"),
  webRoot: join(directory, "web"),
  baikalEndpoint: "http://baikal.test/dav.php/",
  credentialKeyPath: join(directory, "credential.key"),
  secureCookies: false,
  build: { version: "test", revision: "test", builtAt: null },
});

type Proof = Record<string, string> & { readonly "X-Suite-Client-Id": string };

/** Reads the frames of one `text/event-stream` response. */
class HintStream {
  readonly response: Response;
  /** Every frame as received, comments included. */
  readonly raw: string[] = [];
  readonly #queue: string[] = [];
  readonly #waiters: ((frame: string | undefined) => void)[] = [];
  readonly #reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  #ended = false;

  constructor(response: Response) {
    this.response = response;
    this.#reader = response.body?.getReader();
    void this.#pump();
  }

  async #pump(): Promise<void> {
    const reader = this.#reader;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (reader !== undefined) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary === -1) break;
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          this.raw.push(frame);
          const waiter = this.#waiters.shift();
          if (waiter === undefined) this.#queue.push(frame);
          else waiter(frame);
        }
      }
    } catch {
      // The connection was dropped; the stream is over.
    }
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter(undefined);
  }

  /** The next frame, or undefined when the server closed the stream. */
  frame(timeoutMs = 5000): Promise<string | undefined> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.#ended) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index !== -1) this.#waiters.splice(index, 1);
        reject(new Error("No live sync frame arrived in time"));
      }, timeoutMs);
      const waiter = (frame: string | undefined): void => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.#waiters.push(waiter);
    });
  }

  /** The next event, skipping heartbeat comments. */
  async event(timeoutMs = 5000): Promise<LiveSyncEvent | undefined> {
    for (;;) {
      const frame = await this.frame(timeoutMs);
      if (frame === undefined) return undefined;
      const event = decodeLiveSyncEvent(frame);
      if (event !== undefined) return event;
    }
  }

  /** True when nothing arrives within the window. */
  async quiet(windowMs: number): Promise<boolean> {
    try {
      await this.frame(windowMs);
      return false;
    } catch {
      return true;
    }
  }

  async cancel(): Promise<void> {
    await this.#reader?.cancel().catch(() => undefined);
  }
}

const start = async (
  directory: string,
  options: SuiteServerOptions = {},
): Promise<RunningSuiteServer> => {
  await mkdir(join(directory, "web"), { recursive: true });
  return startSuiteServer(configuration(directory), {
    disableNotificationTimer: true,
    ...options,
  });
};

const signIn = async (server: RunningSuiteServer) => {
  const owner = {
    username: "live",
    displayName: "Live",
    password: "a sufficiently long disposable password",
  };
  await fetch(`${server.baseUrl}/api/setup`, {
    method: "POST",
    headers: { Origin: server.baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify(owner),
  });
  const login = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { Origin: server.baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify(owner),
  });
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  const call = (
    path: string,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${server.baseUrl}${path}`, {
      method,
      headers: {
        Origin: server.baseUrl,
        Cookie: cookie,
        "X-CSRF-Token": csrfToken,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const register = async (label: string): Promise<Proof> => {
    const client = clientRegistrationResponseSchema.parse(
      await (await call("/api/clients", "POST", { label })).json(),
    );
    return {
      "X-Suite-Client-Id": client.client.id,
      "X-Suite-Client-Credential": client.clientCredential,
      "X-Suite-Sync-Version": "2",
    };
  };
  /** Opens the stream the way a client does: a plain GET with the proof. */
  const connect = (proof: Record<string, string>): Promise<Response> =>
    fetch(`${server.baseUrl}${liveSyncPath}`, {
      headers: { Cookie: cookie, ...proof },
    });
  const stream = async (proof: Proof): Promise<HintStream> => {
    const response = await connect(proof);
    expect(response.status).toBe(200);
    return new HintStream(response);
  };
  return { call, register, connect, stream, cookie };
};

const uuidPattern =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

describe("live sync hint stream (ADR 0045)", () => {
  it("greets a client, hints a feed change to another client within a second and carries no content", async () => {
    await withTemporaryDirectory(async (directory) => {
      const server = await start(directory);
      try {
        const { call, register, stream } = await signIn(server);
        const laptop = await register("Laptop");
        const phone = await register("Phone");
        const laptopStream = await stream(laptop);
        const phoneStream = await stream(phone);

        expect(phoneStream.response.headers.get("content-type")).toBe(
          "text/event-stream; charset=utf-8",
        );
        expect(phoneStream.response.headers.get("cache-control")).toBe(
          "no-store",
        );
        expect(phoneStream.response.headers.get("x-accel-buffering")).toBe(
          "no",
        );
        const hello = await phoneStream.event();
        expect(hello?.event).toBe("hello");
        if (hello?.event !== "hello") throw new Error("hello missing");
        expect(hello.data).toMatchObject({
          protocolVersion: 2,
          heartbeatSeconds: liveSyncHeartbeatSeconds,
        });
        expect((await laptopStream.event())?.event).toBe("hello");

        // The phone is up to date: a round from the hello head is empty.
        const before = syncRoundResponseSchema.parse(
          await (
            await call(
              "/api/sync/round",
              "POST",
              { cursor: hello.data.head, operations: [], pullLimit: 100 },
              phone,
            )
          ).json(),
        );
        expect(before.changes).toEqual([]);
        expect(before.nextCursor).toBe(hello.data.head);

        // The laptop creates a task through a sync round.
        const taskId = randomUUID();
        const title = "Secret harvest plan";
        const started = performance.now();
        const write = await call(
          "/api/sync/round",
          "POST",
          {
            cursor: hello.data.head,
            operations: [
              {
                kind: "task.create",
                operationId: randomUUID(),
                clientSequence: 1,
                createdAt: new Date().toISOString(),
                requestHash: "a".repeat(43),
                task: { id: taskId, title, notes: "", estimateMinutes: null },
              },
            ],
            pullLimit: 100,
          },
          laptop,
        );
        expect(write.status).toBe(200);
        const hint = await phoneStream.event(1000);
        const latencyMs = performance.now() - started;
        expect(hint?.event).toBe("changes");
        if (hint?.event !== "changes") throw new Error("changes missing");
        expect(latencyMs).toBeLessThan(1000);
        // Recorded for the wave report; loopback latency is the coalescing
        // window plus one request.
        console.info(
          `live sync hint latency on loopback: ${latencyMs.toFixed(0)} ms`,
        );
        expect(hint.data.head).not.toBe(hello.data.head);

        // The phone's following round returns the change and reaches the head.
        const after = syncRoundResponseSchema.parse(
          await (
            await call(
              "/api/sync/round",
              "POST",
              { cursor: hello.data.head, operations: [], pullLimit: 100 },
              { ...phone, "X-Suite-Sync-Trigger": "push" },
            )
          ).json(),
        );
        expect(after.changes.map(({ entityId }) => entityId)).toContain(taskId);
        expect(after.nextCursor).toBe(hint.data.head);
        expect(after.hasMore).toBe(false);

        // The writer hears about its own change once and nothing else follows.
        expect(await laptopStream.event(1000)).toEqual(hint);
        expect(await phoneStream.quiet(300)).toBe(true);

        // No frame names a record: the only identifiers are the feed epoch
        // in the cursor and registered client IDs.
        const epoch = hello.data.head.slice(
          0,
          hello.data.head.lastIndexOf("."),
        );
        const allowed = new Set([
          epoch,
          laptop["X-Suite-Client-Id"],
          phone["X-Suite-Client-Id"],
        ]);
        for (const frame of [...laptopStream.raw, ...phoneStream.raw]) {
          expect(frame).not.toContain(title);
          expect(frame).not.toContain(taskId);
          for (const id of frame.match(uuidPattern) ?? [])
            expect(allowed, frame).toContain(id);
        }

        const metrics = await (
          await fetch(`${server.baseUrl}/api/metrics`)
        ).text();
        expect(metrics).toContain("suite_live_sync_streams_open 2");
        expect(metrics).toContain(
          'suite_live_sync_hints_total{event="hello"} 2',
        );
        expect(metrics).toContain(
          'suite_live_sync_hints_total{event="changes"} 2',
        );
        expect(metrics).toContain("suite_live_sync_streams_dropped_total 0");
        expect(metrics).toContain(
          "suite_live_sync_unclassified_mutations_total 0",
        );
        expect(metrics).not.toContain(laptop["X-Suite-Client-Id"]);
        const ready = await fetch(`${server.baseUrl}/api/ready`);
        expect(ready.status).toBe(200);
        expect(JSON.stringify(await ready.json())).not.toContain("live");
        await laptopStream.cancel();
        await phoneStream.cancel();
      } finally {
        await server.close();
      }
    });
  });

  it("hints online-only records with their family and the source client", async () => {
    await withTemporaryDirectory(async (directory) => {
      const server = await start(directory);
      try {
        const { call, register, stream } = await signIn(server);
        const laptop = await register("Laptop");
        const phone = await register("Phone");
        const phoneStream = await stream(phone);
        expect((await phoneStream.event())?.event).toBe("hello");

        // A note written by the laptop with its client proof.
        const content = "Private garden notes";
        const created = await call("/api/notes", "POST", { content }, laptop);
        expect(created.status).toBe(201);
        const { note } = (await created.json()) as { note: { id: string } };
        expect(await phoneStream.event(1000)).toEqual({
          event: "resources",
          data: {
            families: ["notes"],
            sourceClientId: laptop["X-Suite-Client-Id"],
          },
        });

        // Without a client proof, and with a wrong credential, the source is
        // unknown.
        expect(
          (
            await call(`/api/notes/${note.id}`, "DELETE", undefined, {
              "If-Match": '"1"',
              "X-Suite-Client-Id": laptop["X-Suite-Client-Id"],
              "X-Suite-Client-Credential": "A".repeat(43),
            })
          ).status,
        ).toBe(204);
        expect(await phoneStream.event(1000)).toEqual({
          event: "resources",
          data: { families: ["notes"], sourceClientId: null },
        });

        // A rejected mutation sends nothing.
        expect((await call("/api/notes", "POST", { content: "" })).status).toBe(
          400,
        );
        // Preferences are another family.
        const preferences = (await (
          await call("/api/planning/preferences", "GET")
        ).json()) as Record<string, unknown>;
        expect(
          (await call("/api/planning/preferences", "PUT", preferences)).status,
        ).toBe(200);
        expect(await phoneStream.event(1000)).toEqual({
          event: "resources",
          data: { families: ["planning_preferences"], sourceClientId: null },
        });

        // An automation operation names its families and no source client.
        const { token } = createAutomationTokenResponseSchema.parse(
          await (
            await call("/api/automation/tokens", "POST", {
              label: "Assistant",
              scopes: [...automationTokenScopeSchema.options],
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            })
          ).json(),
        );
        expect(await phoneStream.event(1000)).toEqual({
          event: "resources",
          data: { families: ["automation"], sourceClientId: null },
        });
        const automation = (path: string, body: unknown) =>
          fetch(`${server.baseUrl}${path}`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          });
        const previewResponse = await automation(
          "/api/automation/v1/previews",
          {
            operation: "notes.mutate",
            input: { action: "create", id: randomUUID(), content },
          },
        );
        expect(previewResponse.status).toBe(201);
        const { preview } = automationPreviewResponseSchema.parse(
          await previewResponse.json(),
        );
        // A preview changes nothing another device shows.
        expect(await phoneStream.quiet(300)).toBe(true);
        const confirmed = await automation(
          `/api/automation/v1/previews/${preview.id}/confirm`,
          { idempotencyKey: randomUUID() },
        );
        expect(confirmed.status).toBe(200);
        automationConfirmationResponseSchema.parse(await confirmed.json());
        expect(await phoneStream.event(1000)).toEqual({
          event: "resources",
          data: { families: ["notes", "automation"], sourceClientId: null },
        });

        for (const frame of phoneStream.raw) {
          expect(frame).not.toContain(content);
          expect(frame).not.toContain(note.id);
          expect(frame).not.toContain(preview.id);
        }
        const metrics = await (
          await fetch(`${server.baseUrl}/api/metrics`)
        ).text();
        expect(metrics).toContain(
          'suite_live_sync_hints_total{event="resources"} 5',
        );
        expect(metrics).toContain(
          "suite_live_sync_unclassified_mutations_total 0",
        );
        await phoneStream.cancel();
      } finally {
        await server.close();
      }
    });
  });

  it("requires the session and the client proof of a sync round", async () => {
    await withTemporaryDirectory(async (directory) => {
      const server = await start(directory);
      try {
        const { register, connect } = await signIn(server);
        const laptop = await register("Laptop");
        const anonymous = await fetch(`${server.baseUrl}${liveSyncPath}`, {
          headers: laptop,
        });
        expect(anonymous.status).toBe(401);
        expect(((await anonymous.json()) as { code: string }).code).toBe(
          "AUTH_REQUIRED",
        );
        const noProof = await connect({});
        expect(noProof.status).toBe(401);
        expect(((await noProof.json()) as { code: string }).code).toBe(
          "CLIENT_AUTH_REQUIRED",
        );
        const wrongCredential = await connect({
          ...laptop,
          "X-Suite-Client-Credential": "A".repeat(43),
        });
        expect(wrongCredential.status).toBe(401);
        expect(((await wrongCredential.json()) as { code: string }).code).toBe(
          "CLIENT_REVOKED",
        );
        const oldProtocol = await connect({
          ...laptop,
          "X-Suite-Sync-Version": "1",
        });
        expect(oldProtocol.status).toBe(426);
        await oldProtocol.body?.cancel();
      } finally {
        await server.close();
      }
    });
  });

  it("replaces a client's stream and allows at most eight streams per owner", async () => {
    await withTemporaryDirectory(async (directory) => {
      const server = await start(directory);
      try {
        const { register, connect, stream } = await signIn(server);
        const first = await register("Client 1");
        const original = await stream(first);
        expect((await original.event())?.event).toBe("hello");
        const replacement = await stream(first);
        expect((await replacement.event())?.event).toBe("hello");
        expect(await original.event()).toEqual({
          event: "bye",
          data: { reason: "replaced" },
        });
        expect(await original.frame()).toBeUndefined();

        const streams = [replacement];
        for (let index = 2; index <= 8; index += 1) {
          const opened = await stream(
            await register(`Client ${String(index)}`),
          );
          expect((await opened.event())?.event).toBe("hello");
          streams.push(opened);
        }
        const ninth = await register("Client 9");
        const refused = await connect(ninth);
        expect(refused.status).toBe(429);
        expect(((await refused.json()) as { code: string }).code).toBe(
          "LIVE_SYNC_STREAM_LIMIT",
        );
        // A client that already holds a stream can still reconnect.
        const again = await stream(first);
        expect((await again.event())?.event).toBe("hello");
        expect(await replacement.event()).toEqual({
          event: "bye",
          data: { reason: "replaced" },
        });
        // A closed stream frees its place.
        await streams[1]?.cancel();
        await expect
          .poll(async () => {
            const response = await connect(ninth);
            await response.body?.cancel();
            return response.status;
          })
          .toBe(200);
        for (const open of [...streams.slice(2), again]) await open.cancel();
      } finally {
        await server.close();
      }
    });
  });

  it("ends the stream of a revoked client and of a signed-out session", async () => {
    await withTemporaryDirectory(async (directory) => {
      const server = await start(directory);
      try {
        const { call, register, stream } = await signIn(server);
        const laptop = await register("Laptop");
        const phone = await register("Phone");
        const laptopStream = await stream(laptop);
        const phoneStream = await stream(phone);
        expect((await laptopStream.event())?.event).toBe("hello");
        expect((await phoneStream.event())?.event).toBe("hello");

        expect(
          (await call(`/api/clients/${phone["X-Suite-Client-Id"]}`, "DELETE"))
            .status,
        ).toBe(204);
        expect(await phoneStream.event()).toEqual({
          event: "bye",
          data: { reason: "client-revoked" },
        });
        expect(await phoneStream.frame()).toBeUndefined();
        expect(await laptopStream.quiet(300)).toBe(true);

        expect((await call("/api/auth/logout", "POST")).status).toBe(200);
        expect(await laptopStream.event()).toEqual({
          event: "bye",
          data: { reason: "session-ended" },
        });
        expect(await laptopStream.frame()).toBeUndefined();
      } finally {
        await server.close();
      }
    });
  });

  it("says bye: shutdown before the server stops", async () => {
    await withTemporaryDirectory(async (directory) => {
      const server = await start(directory);
      const { register, stream, connect } = await signIn(server);
      const laptop = await register("Laptop");
      const laptopStream = await stream(laptop);
      expect((await laptopStream.event())?.event).toBe("hello");
      const started = performance.now();
      await server.close();
      expect(performance.now() - started).toBeLessThan(2000);
      expect(await laptopStream.event()).toEqual({
        event: "bye",
        data: { reason: "shutdown" },
      });
      expect(await laptopStream.frame()).toBeUndefined();
      await expect(connect(laptop)).rejects.toThrow();
    });
  });

  it("sends heartbeats, sees writes outside a request on the tick and ends an expired session", async () => {
    await withTemporaryDirectory(async (directory) => {
      const timers = new ManualLiveSyncTimers(Date.now());
      const server = await start(directory, { liveSyncTimers: timers });
      const other = SuiteDatabase.open(join(directory, "suite.sqlite"));
      try {
        const { register, stream } = await signIn(server);
        const laptop = await register("Laptop");
        const laptopStream = await stream(laptop);
        const hello = await laptopStream.event();
        if (hello?.event !== "hello") throw new Error("hello missing");

        // Nothing is written until the heartbeat interval has passed.
        timers.advance(liveSyncHeartbeatSeconds * 1000 - 2000);
        expect(await laptopStream.quiet(200)).toBe(true);
        timers.advance(2000);
        expect(await laptopStream.frame()).toBe(": hb");

        // A write by another process (or a server tick) reaches the feed
        // without a request; the two-second tick announces it.
        const ownerId = other.getActiveOwnerId();
        if (ownerId === undefined) throw new Error("owner missing");
        const change = other.appendSyncChange(
          ownerId,
          "task",
          randomUUID(),
          "upsert",
          1,
          new Date().toISOString(),
        );
        expect(await laptopStream.quiet(200)).toBe(true);
        timers.advance(2000);
        timers.advance(100);
        const epoch = hello.data.head.slice(
          0,
          hello.data.head.lastIndexOf("."),
        );
        expect(await laptopStream.event()).toEqual({
          event: "changes",
          data: { head: `${epoch}.${String(change.sequence)}` },
        });

        // The idle limit passes without owner activity: the stream did not
        // keep the session alive, and the next tick ends it.
        const database = new DatabaseSync(join(directory, "suite.sqlite"));
        database
          .prepare("UPDATE web_sessions SET idle_expires_at = ?")
          .run(new Date(Date.now() - 1000).toISOString());
        database.close();
        timers.advance(2000);
        expect(await laptopStream.event()).toEqual({
          event: "bye",
          data: { reason: "session-ended" },
        });
        expect(await laptopStream.frame()).toBeUndefined();
        expect(timers.pending).toBe(0);
      } finally {
        other.close();
        await server.close();
      }
    });
  });

  it("does not refresh the session idle timer for the stream or a hint-triggered round", async () => {
    await withTemporaryDirectory(async (directory) => {
      const server = await start(directory);
      try {
        const { call, register, stream } = await signIn(server);
        const laptop = await register("Laptop");
        const idleExpiry = (): string => {
          const database = new DatabaseSync(join(directory, "suite.sqlite"), {
            readOnly: true,
          });
          try {
            const row = database
              .prepare("SELECT idle_expires_at FROM web_sessions")
              .get() as { idle_expires_at: string };
            return row.idle_expires_at;
          } finally {
            database.close();
          }
        };
        const pause = () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 20);
          });
        const round = (headers: Record<string, string>) =>
          call(
            "/api/sync/round",
            "POST",
            { cursor: null, operations: [], pullLimit: 100 },
            { ...laptop, ...headers },
          );
        const initial = idleExpiry();

        await pause();
        const laptopStream = await stream(laptop);
        expect((await laptopStream.event())?.event).toBe("hello");
        expect(idleExpiry()).toBe(initial);

        await pause();
        expect((await round({ "X-Suite-Sync-Trigger": "push" })).status).toBe(
          200,
        );
        expect(idleExpiry()).toBe(initial);

        await pause();
        expect((await round({})).status).toBe(200);
        const refreshed = idleExpiry();
        expect(Date.parse(refreshed)).toBeGreaterThan(Date.parse(initial));

        // Any other trigger value is an ordinary round.
        await pause();
        expect((await round({ "X-Suite-Sync-Trigger": "load" })).status).toBe(
          200,
        );
        const afterRound = idleExpiry();
        expect(Date.parse(afterRound)).toBeGreaterThan(Date.parse(refreshed));

        // The header means "not owner activity" on every authenticated route.
        // Reads already leave the idle timer alone; a route that refreshes it
        // (here a rejected note create) does not when the header is present.
        await pause();
        expect((await call("/api/notes", "GET")).status).toBe(200);
        expect(idleExpiry()).toBe(afterRound);
        await pause();
        expect(
          (
            await call(
              "/api/notes",
              "POST",
              {},
              {
                "X-Suite-Sync-Trigger": "push",
              },
            )
          ).status,
        ).toBe(400);
        expect(idleExpiry()).toBe(afterRound);
        await pause();
        expect((await call("/api/notes", "POST", {})).status).toBe(400);
        expect(Date.parse(idleExpiry())).toBeGreaterThan(
          Date.parse(afterRound),
        );
        await laptopStream.cancel();
      } finally {
        await server.close();
      }
    });
  });
});
