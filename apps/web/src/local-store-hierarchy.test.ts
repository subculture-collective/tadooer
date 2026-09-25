import { IDBFactory } from "fake-indexeddb";
import { expect, it } from "vitest";
import type { ClientRegistrationResponse } from "@suite/contracts";
import { LocalStore } from "./local-store.ts";

const registration: ClientRegistrationResponse = {
  client: {
    id: "1b34cc57-972c-42e8-bafa-0ba455dced20",
    ownerId: "728a504a-0997-4eb3-94dd-5d6ff8af5967",
    label: "Test browser",
    createdAt: "2026-09-24T16:00:00.000Z",
    lastSeenAt: "2026-09-24T16:00:00.000Z",
    revokedAt: null,
  },
  clientCredential: "A".repeat(43),
  protocolVersion: 2 as const,
  initialCursor: "sync-v1.epoch.0.tag",
};

it("queues offline child creation as create then move and replays it after a snapshot reset", async () => {
  const store = new LocalStore({
    indexedDb: new IDBFactory(),
    now: () => "2026-09-24T16:00:00.000Z",
  });
  await store.ensureClient(() => Promise.resolve(registration));
  const parent = await store.queueTaskCreate({ title: "Parent" });
  const parentId = parent.kind === "task.create" ? parent.task.id : "";
  const children: string[] = [];
  for (const title of ["First", "Second"]) {
    const created = await store.queueTaskCreate({ title });
    const id = created.kind === "task.create" ? created.task.id : "";
    children.push(id);
    await store.queueTaskMove(id, parentId);
  }
  // Insert the second child before the first.
  const reorder = await store.queueTaskMove(children[1] ?? "", parentId, 0);
  expect(reorder).toMatchObject({
    kind: "task.move",
    parentId,
    index: 0,
    baseParentVersion: 1,
  });
  const byId = new Map(
    (await store.loadCachedTasks()).map(({ task }) => [task.id, task]),
  );
  expect(byId.get(children[0] ?? "")).toMatchObject({
    parentId,
    childPosition: 1024,
  });
  expect(byId.get(children[1] ?? "")?.childPosition).toBe(0);
  expect(
    (await store.loadOutbox()).map(({ operation }) => operation.kind),
  ).toEqual([
    "task.create",
    "task.create",
    "task.move",
    "task.create",
    "task.move",
    "task.move",
  ]);

  // A cursor reset replays pending moves over the server snapshot.
  await store.markResetRequired();
  await store.replaceFromSnapshot({
    protocolVersion: 2,
    snapshots: [],
    nextCursor: "sync-v1.epoch.1.tag",
    hasMore: false,
    serverTimestamp: "2026-09-24T16:01:00.000Z",
  });
  const replayed = await store.loadCachedTasks();
  expect(
    replayed.filter(({ task }) => task.parentId === parentId),
  ).toHaveLength(2);

  // Promoting a child back to top level clears its order key.
  await store.queueTaskMove(children[0] ?? "", null);
  const promoted = (await store.loadCachedTasks()).find(
    ({ task }) => task.id === children[0],
  );
  expect(promoted?.task).toMatchObject({ parentId: null, childPosition: null });
  const manifest = await store.recoverySupportManifest();
  expect(manifest.operations.at(-1)).toMatchObject({
    kind: "task.move",
    baseRevision: null,
  });
});
