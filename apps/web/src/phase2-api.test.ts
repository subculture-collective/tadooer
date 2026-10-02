import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commandActiveSession,
  createProject,
  createSyncTransport,
  getActiveSession,
  getSyncSnapshot,
  instantiateTemplate,
  getNotificationStatus,
  sendTestNotification,
  syncRound,
  updateNotificationPreferences,
} from "./api.ts";
import { SyncCursorResetRequired } from "./sync-engine.ts";

const client = {
  installationId: "d1054acd-c04d-4bd8-a814-254b007154ba",
  clientId: "1b34cc57-972c-42e8-bafa-0ba455dced20",
  clientCredential: "A".repeat(43),
  cursor: "sync-v1.epoch.1.tag",
};

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => vi.unstubAllGlobals());

describe("Phase 2 API transport", () => {
  it("uses authenticated notification preference, status, and test routes", async () => {
    const calls: { path: string; method: string; csrf: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init: RequestInit = {}) => {
        calls.push({
          path,
          method: init.method ?? "GET",
          csrf: new Headers(init.headers).get("x-csrf-token"),
        });
        if (path.endsWith("/preferences"))
          return Promise.resolve(
            response({
              enabled: true,
              leadReminderEnabled: true,
              atStartReminderEnabled: true,
              detailedContentEnabled: true,
            }),
          );
        if (path.endsWith("/status"))
          return Promise.resolve(
            response({
              configured: true,
              enabled: true,
              state: "ready",
              pendingCount: 0,
              failedCount: 0,
              lastDelivery: null,
            }),
          );
        return Promise.resolve(
          response({ accepted: true, state: "delivered", errorCode: null }),
        );
      }),
    );
    await updateNotificationPreferences(
      {
        enabled: true,
        leadReminderEnabled: true,
        atStartReminderEnabled: true,
        detailedContentEnabled: true,
      },
      "csrf-token",
    );
    await getNotificationStatus();
    await sendTestNotification("csrf-token");
    expect(calls).toEqual([
      {
        path: "/api/notifications/preferences",
        method: "PUT",
        csrf: "csrf-token",
      },
      { path: "/api/notifications/status", method: "GET", csrf: null },
      {
        path: "/api/notifications/test",
        method: "POST",
        csrf: "csrf-token",
      },
    ]);
  });

  it("instantiates a template with an explicit destination and retry key", async () => {
    const fetcher = vi.fn((path: string, init: RequestInit) => {
      expect(path).toBe(
        "/api/templates/d1054acd-c04d-4bd8-a814-254b007154ba/instantiate",
      );
      const headers = new Headers(init.headers);
      expect(init.method).toBe("POST");
      expect(headers.get("x-csrf-token")).toBe("csrf-token");
      expect(headers.get("idempotency-key")).toBe("instantiate-0001");
      expect(JSON.parse(init.body as string)).toEqual({
        destinationProjectId: "1b34cc57-972c-42e8-bafa-0ba455dced20",
        idempotencyKey: "instantiate-0001",
      });
      return Promise.resolve(
        response({
          instantiationId: "728a504a-0997-4eb3-94dd-5d6ff8af5967",
          replayed: false,
          tasks: [
            {
              task: {
                id: "afcab502-2199-43fd-b9d3-c8b556c6f25b",
                title: "Weekly review",
                notes: "",
                status: "open",
                revision: 1,
                createdAt: "2026-08-06T12:00:00.000Z",
                updatedAt: "2026-08-06T12:00:00.000Z",
                completedAt: null,
                deletedAt: null,
              },
              subtasks: [],
              provenance: {
                taskId: "afcab502-2199-43fd-b9d3-c8b556c6f25b",
                templateId: "d1054acd-c04d-4bd8-a814-254b007154ba",
                templateRevision: 1,
                instantiationId: "728a504a-0997-4eb3-94dd-5d6ff8af5967",
                instantiatedAt: "2026-08-06T12:00:00.000Z",
              },
            },
          ],
        }),
      );
    });
    vi.stubGlobal("fetch", fetcher);

    const result = await instantiateTemplate(
      "d1054acd-c04d-4bd8-a814-254b007154ba",
      "1b34cc57-972c-42e8-bafa-0ba455dced20",
      "csrf-token",
      "instantiate-0001",
    );
    expect(result.tasks[0]?.task.title).toBe("Weekly review");
  });

  it("registers a client through the stable SyncTransport factory", async () => {
    const fetcher = vi.fn((_path: string, init: RequestInit) => {
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("x-csrf-token")).toBe("csrf-token");
      if (typeof init.body !== "string")
        throw new Error("Expected JSON request body");
      expect(JSON.parse(init.body)).toEqual({ label: "This browser" });
      return Promise.resolve(
        response(
          {
            client: {
              id: client.clientId,
              ownerId: "728a504a-0997-4eb3-94dd-5d6ff8af5967",
              label: "This browser",
            },
            clientCredential: client.clientCredential,
            protocolVersion: 2 as const,
            initialCursor: "sync-v1.epoch.1.tag",
          },
          201,
        ),
      );
    });
    vi.stubGlobal("fetch", fetcher);

    const registered = await createSyncTransport("csrf-token").registerClient();

    expect(registered.client.id).toBe(client.clientId);
  });

  it("turns a server cursor reset into a typed recovery signal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          response(
            {
              code: "SYNC_CURSOR_EXPIRED",
              message: "Sync cursor expired",
              requestId: "d1054acd-c04d-4bd8-a814-254b007154ba",
              action: "replace_cache_from_snapshot",
            },
            409,
          ),
        ),
      ),
    );

    await expect(
      syncRound(client, "csrf-token", {
        cursor: client.cursor,
        operations: [],
        pullLimit: 100,
      }),
    ).rejects.toBeInstanceOf(SyncCursorResetRequired);
  });

  it("collects every bounded snapshot page before returning the reset cursor", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) => {
        calls.push(path);
        return Promise.resolve(
          response({
            snapshots:
              calls.length === 1
                ? [
                    {
                      entityKind: "project",
                      value: {
                        id: "728a504a-0997-4eb3-94dd-5d6ff8af5967",
                        ownerId: "4519c805-e478-486b-a918-616fc6d9ea98",
                        title: "Home",
                        revision: 1,
                        createdAt: "2026-08-06T16:00:00.000Z",
                        updatedAt: "2026-08-06T16:00:00.000Z",
                        archivedAt: null,
                      },
                    },
                  ]
                : [],
            nextCursor: "sync-v1.epoch.2.tag",
            hasMore: calls.length === 1,
            protocolVersion: 2 as const,
            serverTimestamp: "2026-08-06T16:00:00.000Z",
          }),
        );
      }),
    );

    const snapshot = await getSyncSnapshot(client);

    expect(calls).toEqual([
      "/api/sync/snapshot?offset=0",
      "/api/sync/snapshot?offset=1",
    ]);
    expect(snapshot).toMatchObject({
      nextCursor: "sync-v1.epoch.2.tag",
      hasMore: false,
    });
  });

  it("pages a snapshot by what the server sent when it skips unknown kinds (ADR 0050)", async () => {
    const calls: string[] = [];
    const project = (id: string) => ({
      entityKind: "project",
      value: {
        id,
        ownerId: "4519c805-e478-486b-a918-616fc6d9ea98",
        title: "Home",
        revision: 1,
        createdAt: "2026-08-06T16:00:00.000Z",
        updatedAt: "2026-08-06T16:00:00.000Z",
        archivedAt: null,
      },
    });
    const unknown = { entityKind: "kanban_lane", value: { id: "lane" } };
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) => {
        calls.push(path);
        const first = calls.length === 1;
        return Promise.resolve(
          response({
            // A page of unknown kinds only must not stop the pagination.
            snapshots: first
              ? [unknown, unknown]
              : calls.length === 2
                ? [project("728a504a-0997-4eb3-94dd-5d6ff8af5967"), unknown]
                : [],
            nextCursor: "sync-v1.epoch.2.tag",
            hasMore: calls.length < 3,
            protocolVersion: 2 as const,
            serverTimestamp: "2026-08-06T16:00:00.000Z",
          }),
        );
      }),
    );

    const snapshot = await getSyncSnapshot(client);

    expect(calls).toEqual([
      "/api/sync/snapshot?offset=0",
      "/api/sync/snapshot?offset=2",
      "/api/sync/snapshot?offset=4",
    ]);
    expect(snapshot.snapshots).toHaveLength(1);
    expect(snapshot.skippedUnknownKinds).toBe(3);
  });

  it("skips a sync round change of an unknown kind and keeps the round's cursor (ADR 0050)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          response({
            protocolVersion: 2,
            outcomes: [],
            changes: [
              {
                sequence: 5,
                entityKind: "kanban_lane",
                entityId: "728a504a-0997-4eb3-94dd-5d6ff8af5967",
                kind: "upsert",
                entityRevision: 1,
                changedAt: "2026-08-06T16:00:00.000Z",
                snapshot: { entityKind: "kanban_lane", value: {} },
              },
            ],
            nextCursor: "sync-v1.epoch.5.tag",
            hasMore: false,
            serverTimestamp: "2026-08-06T16:00:00.000Z",
          }),
        ),
      ),
    );
    await expect(
      syncRound(client, "csrf-token", {
        cursor: client.cursor,
        operations: [],
        pullLimit: 100,
      }),
    ).resolves.toMatchObject({
      changes: [],
      skippedUnknownKinds: 1,
      nextCursor: "sync-v1.epoch.5.tag",
    });
  });

  it("restarts snapshot pagination when the authoritative cursor changes", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) => {
        calls.push(path);
        const retry = calls.length > 2;
        const firstPage = path.endsWith("offset=0");
        return Promise.resolve(
          response({
            snapshots: firstPage
              ? [
                  {
                    entityKind: "project",
                    value: {
                      id: "728a504a-0997-4eb3-94dd-5d6ff8af5967",
                      ownerId: "4519c805-e478-486b-a918-616fc6d9ea98",
                      title: "Home",
                      revision: 1,
                      createdAt: "2026-08-06T16:00:00.000Z",
                      updatedAt: "2026-08-06T16:00:00.000Z",
                      archivedAt: null,
                    },
                  },
                ]
              : [],
            nextCursor:
              retry || !firstPage
                ? "sync-v1.epoch.3.tag"
                : "sync-v1.epoch.2.tag",
            hasMore: firstPage,
            protocolVersion: 2 as const,
            serverTimestamp: "2026-08-06T16:00:00.000Z",
          }),
        );
      }),
    );

    const snapshot = await getSyncSnapshot(client);

    expect(calls).toEqual([
      "/api/sync/snapshot?offset=0",
      "/api/sync/snapshot?offset=1",
      "/api/sync/snapshot?offset=0",
      "/api/sync/snapshot?offset=1",
    ]);
    expect(snapshot).toMatchObject({
      nextCursor: "sync-v1.epoch.3.tag",
      hasMore: false,
    });
    expect(snapshot.snapshots).toHaveLength(1);
  });

  it("uses client proof for active-session reads and commands", async () => {
    const fetcher = vi.fn((_path: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      expect(headers.get("x-suite-client-id")).toBe(client.clientId);
      expect(headers.get("x-suite-client-credential")).toBe(
        client.clientCredential,
      );
      if (init.method === "POST") {
        expect(headers.get("x-csrf-token")).toBe("csrf-token");
        return Promise.resolve(
          response({
            session: {
              id: "728a504a-0997-4eb3-94dd-5d6ff8af5967",
              ownerId: "4519c805-e478-486b-a918-616fc6d9ea98",
              taskId: "afcab502-2199-43fd-b9d3-c8b556c6f25b",
              controllerClientId: client.clientId,
              state: "paused",
              phase: "focus",
              revision: 2,
              startedAt: "2026-08-06T16:00:00.000Z",
              updatedAt: "2026-08-06T16:01:00.000Z",
              leaseExpiresAt: null,
              hardExpiresAt: "2026-08-07T16:00:00.000Z",
              currentIntervalId: null,
            },
            openedInterval: null,
            closedInterval: null,
            replayed: false,
            changeSequence: 2,
          }),
        );
      }
      return Promise.resolve(response({ session: null }));
    });
    vi.stubGlobal("fetch", fetcher);

    expect(await getActiveSession(client)).toBeNull();
    const result = await commandActiveSession(client, "csrf-token", {
      command: "pause",
      sessionId: "728a504a-0997-4eb3-94dd-5d6ff8af5967",
      expectedRevision: 1,
      idempotencyKey: "pause-request-0001",
    });
    expect(result.session.revision).toBe(2);
  });

  it("validates organization input before posting it", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        response(
          {
            project: {
              id: "d1054acd-c04d-4bd8-a814-254b007154ba",
              ownerId: "1b34cc57-972c-42e8-bafa-0ba455dced20",
              title: "Home",
              revision: 1,
              createdAt: "2026-08-06T16:00:00.000Z",
              updatedAt: "2026-08-06T16:00:00.000Z",
              archivedAt: null,
            },
          },
          201,
        ),
      ),
    );
    vi.stubGlobal("fetch", fetcher);

    expect(() => createProject("   ", "csrf-token")).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect((await createProject("Home", "csrf-token")).title).toBe("Home");
  });
});
