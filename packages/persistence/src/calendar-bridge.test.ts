import { join } from "node:path";
import { expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import { SuiteDatabase, type CalendarBridgeSideState } from "./index.ts";

// Calendar bridge store (issue #40, ADR 0041): owner scoping, outbox rules,
// accepted state, conflicts and backup/restore of mapping state.
const now = "2026-09-25T12:00:00.000Z";
const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const mappingId = "33333333-3333-4333-8333-333333333333";
const linkId = "44444444-4444-4444-8444-444444444444";

const setup = (database: SuiteDatabase, ownerId: string) => {
  database.createOwner({
    id: ownerId,
    username: ownerId.slice(0, 8),
    displayName: "Owner",
    passwordHash: "hash",
    createdAt: now,
  });
  const google = database.ensureCalendarProvider(ownerId, "google", "g", now);
  const baikal = database.ensureCalendarProvider(ownerId, "baikal", "b", now);
  const collection = (providerId: string, href: string) =>
    database.putCalendarCollections(
      providerId,
      [{ href, displayName: href, supportsEvents: true, supportsTodos: false }],
      now,
    )[0]?.id ?? "";
  return {
    google: collection(google.id, "owner@example.test"),
    baikal: collection(baikal.id, "/dav.php/calendars/alice/work/"),
    baikalOther: collection(baikal.id, "/dav.php/calendars/alice/home/"),
  };
};

const present = (
  revision: string,
  digest: string,
): CalendarBridgeSideState => ({
  kind: "present",
  revision,
  digest,
  snapshot: `{"digest":"${digest}"}`,
});
const unknown: CalendarBridgeSideState = {
  kind: "unknown",
  revision: null,
  digest: null,
  snapshot: null,
};

const open = (directory: string) => {
  const database = SuiteDatabase.open(join(directory, "suite.sqlite"));
  const calendars = setup(database, owner);
  const store = database.calendarBridge;
  const created = store.createMapping({
    id: mappingId,
    ownerId: owner,
    googleCalendarId: calendars.google,
    baikalCalendarId: calendars.baikal,
    direction: "two_way",
    initialSync: "copy_existing",
    now,
  });
  expect(created.kind).toBe("created");
  return { database, store, calendars };
};

const linkWithCreate = (
  store: SuiteDatabase["calendarBridge"],
  operationId = "55555555-5555-4555-8555-555555555555",
) =>
  store.insertLinkWithCreate(
    {
      id: linkId,
      mappingId,
      ownerId: owner,
      origin: "google",
      googleEventId: "evt1",
      googleIcalUid: "evt1@google.com",
      baikalHref: `/dav.php/calendars/alice/work/${linkId}.ics`,
      baikalUid: "evt1@google.com",
      google: present('"g1"', "d1"),
      baikal: unknown,
      status: "pending",
      statusReason: "create",
      now,
    },
    {
      id: operationId,
      target: "baikal",
      action: "create",
      targetNativeId: `/dav.php/calendars/alice/work/${linkId}.ics`,
      targetUid: "evt1@google.com",
      expectedRevision: null,
      sourceSide: "google",
      sourceRevision: '"g1"',
      payload: '{"digest":"d1"}',
      payloadDigest: "d1",
      reason: "create",
    },
    1,
  );

it("applies the bridge migration and scopes mappings to their owner", async () => {
  await withTemporaryDirectory((directory) => {
    const { database, store, calendars } = open(directory);
    expect(database.state().appliedMigrationCount).toBe(40);
    expect(store.listMappings(owner)).toHaveLength(1);
    expect(store.listMappings(other)).toEqual([]);
    expect(store.getMapping(other, mappingId)).toBeUndefined();
    expect(store.getMapping(owner, mappingId)).toMatchObject({
      googleCalendarRef: "owner@example.test",
      baikalCalendarRef: "/dav.php/calendars/alice/work/",
      enabled: true,
      revision: 1,
    });
    // One live mapping per calendar; kinds must match the sides.
    expect(
      store.createMapping({
        id: "66666666-6666-4666-8666-666666666666",
        ownerId: owner,
        googleCalendarId: calendars.google,
        baikalCalendarId: calendars.baikalOther,
        direction: "two_way",
        initialSync: "new_only",
        now,
      }).kind,
    ).toBe("calendar-in-use");
    expect(
      store.createMapping({
        id: "66666666-6666-4666-8666-666666666666",
        ownerId: owner,
        googleCalendarId: calendars.baikalOther,
        baikalCalendarId: calendars.google,
        direction: "two_way",
        initialSync: "new_only",
        now,
      }).kind,
    ).toBe("invalid-calendar");
    expect(
      store.createMapping({
        id: "66666666-6666-4666-8666-666666666666",
        ownerId: other,
        googleCalendarId: calendars.google,
        baikalCalendarId: calendars.baikalOther,
        direction: "two_way",
        initialSync: "new_only",
        now,
      }).kind,
    ).toBe("invalid-calendar");
    database.close();
  });
});

it("keeps one unfinished operation per link and accepts receipts atomically", async () => {
  await withTemporaryDirectory((directory) => {
    const { database, store } = open(directory);
    const operation = linkWithCreate(store);
    expect(operation).toMatchObject({ sequence: 1, state: "pending" });
    const link = store.getLink(linkId);
    if (link === undefined) throw new Error("link missing");
    expect(
      store.enqueueOperation({
        link,
        mappingRevision: 1,
        operation: {
          id: "77777777-7777-4777-8777-777777777777",
          target: "baikal",
          action: "update",
          targetNativeId: link.baikalHref ?? "",
          targetUid: null,
          expectedRevision: '"b1"',
          sourceSide: "google",
          sourceRevision: '"g2"',
          payload: "{}",
          payloadDigest: "d2",
          reason: "propagate",
        },
        now,
      }),
    ).toBe("busy");
    expect(store.markDispatched(operation.id, now)).toBe(true);
    expect(store.markDispatched(operation.id, now)).toBe(false);
    expect(
      store.completeOperation(operation.id, {
        google: present('"g1"', "d1"),
        baikal: present('"b1"', "d1"),
        accepted: {
          kind: "present",
          digest: "d1",
          snapshot: '{"digest":"d1"}',
        },
        now,
      }),
    ).toBe(true);
    // A replayed receipt is ignored.
    expect(
      store.completeOperation(operation.id, {
        google: present('"g9"', "x"),
        baikal: present('"b9"', "x"),
        accepted: { kind: "present", digest: "x", snapshot: "{}" },
        now,
      }),
    ).toBe(false);
    expect(store.getLink(linkId)).toMatchObject({
      status: "active",
      acceptedKind: "present",
      acceptedDigest: "d1",
      baikal: { kind: "present", revision: '"b1"' },
    });
    expect(store.getOperation(operation.id)).toMatchObject({
      state: "applied",
      attempts: 1,
    });
    database.close();
  });
});

it("retains conflicts, binds deletion approval and resolves by new work", async () => {
  await withTemporaryDirectory((directory) => {
    const { database, store } = open(directory);
    const operation = linkWithCreate(store);
    store.completeOperation(operation.id, {
      google: present('"g1"', "d1"),
      baikal: present('"b1"', "d1"),
      accepted: { kind: "present", digest: "d1", snapshot: "{}" },
      now,
    });
    const link = store.getLink(linkId);
    if (link === undefined) throw new Error("link missing");
    const conflict = store.openConflict({
      id: "88888888-8888-4888-8888-888888888888",
      link,
      reason: "concurrent-change",
      google: {
        kind: "present",
        revision: '"g2"',
        digest: "dg",
        snapshot: '{"g":1}',
      },
      baikal: {
        kind: "present",
        revision: '"b2"',
        digest: "db",
        snapshot: '{"b":1}',
      },
      now,
    });
    // Same observation again: the same open conflict.
    expect(
      store.openConflict({
        id: "99999999-9999-4999-8999-999999999999",
        link,
        reason: "concurrent-change",
        google: conflict.google,
        baikal: conflict.baikal,
        now,
      }).id,
    ).toBe(conflict.id);
    expect(store.getLink(linkId)?.status).toBe("conflict");
    const resolved = store.resolveConflict({
      ownerId: owner,
      mappingId,
      conflictId: conflict.id,
      keep: "baikal",
      operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      now,
    });
    expect(resolved).toMatchObject({
      kind: "resolved",
      operation: {
        target: "google",
        action: "update",
        expectedRevision: '"g2"',
        payload: '{"b":1}',
        payloadDigest: "db",
        reason: "resolution",
      },
    });
    expect(store.listOpenConflicts(mappingId)).toEqual([]);
    expect(
      store.resolveConflict({
        ownerId: other,
        mappingId,
        conflictId: conflict.id,
        keep: "google",
        operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        now,
      }).kind,
    ).toBe("not-found");

    // Deletion approval requires a blocked deletion with an observed proof.
    const current = store.getLink(linkId);
    expect(
      store.approveDeletion({
        ownerId: owner,
        mappingId,
        linkId,
        expectedRevision: current?.revision ?? 0,
        now,
      }).kind,
    ).toBe("not-pending");
    database.close();
  });
});

it("refuses to remove a mapping with in-flight work and never deletes events", async () => {
  await withTemporaryDirectory((directory) => {
    const { database, store } = open(directory);
    const operation = linkWithCreate(store);
    const revision = store.getMapping(owner, mappingId)?.revision ?? 0;
    const remove = (cancelPending: boolean, expected = revision) =>
      store.removeMapping({
        ownerId: owner,
        mappingId,
        expectedRevision: expected,
        cancelPending,
        now,
      });
    expect(remove(false, revision + 1)).toBe("conflict");
    expect(remove(false)).toBe("pending-work");
    store.markDispatched(operation.id, now);
    expect(remove(true)).toBe("in-flight");
    store.returnToPending(operation.id, "not-applied", now);
    expect(remove(true)).toBe("removed");
    expect(store.getOperation(operation.id)?.state).toBe("cancelled");
    expect(store.listMappings(owner)).toEqual([]);
    // Links stay as provenance; a new mapping sees the identity elsewhere.
    expect(store.getLink(linkId)).toBeDefined();
    expect(
      store.identityLinkedElsewhere({
        ownerId: owner,
        mappingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        side: "google",
        nativeId: "evt1",
      }),
    ).toBe(true);
    database.close();
  });
});

it("restores mappings, links, tombstones and the outbox from a backup", async () => {
  await withTemporaryDirectory((directory) => {
    const { database, store } = open(directory);
    const operation = linkWithCreate(store);
    store.markDispatched(operation.id, now);
    store.markUncertain(operation.id, "baikal-transport-failed", now);
    const backup = join(directory, "backup.sqlite");
    database.backup(backup);
    database.close();
    const restored = SuiteDatabase.open(backup);
    expect(restored.state().appliedMigrationCount).toBe(40);
    expect(restored.calendarBridge.getMapping(owner, mappingId)).toBeDefined();
    expect(restored.calendarBridge.getLink(linkId)).toMatchObject({
      googleEventId: "evt1",
      status: "pending",
    });
    expect(
      restored.calendarBridge.listUnfinishedOperations(mappingId),
    ).toMatchObject([{ id: operation.id, state: "uncertain" }]);
    restored.close();
  });
});
