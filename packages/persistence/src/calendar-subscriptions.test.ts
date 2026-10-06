import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import {
  SuiteDatabase,
  calendarSubscriptionHiddenEventLimit,
} from "./index.ts";

// iCal subscriptions (issue #91, ADR 0032): store behavior and owner scoping.
const now = "2026-09-25T12:00:00.000Z";
const later = "2026-09-25T13:00:00.000Z";
const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const subscriptionId = "33333333-3333-4333-8333-333333333333";
const secretMarker = "FEED-URL-SECRET-MARKER";

const open = (directory: string, file = "db.sqlite"): SuiteDatabase => {
  const database = SuiteDatabase.open(join(directory, file));
  if (database.findOwnerById(owner) === undefined)
    database.createOwner({
      id: owner,
      username: "owner",
      displayName: "Owner",
      passwordHash: "hash",
      createdAt: now,
    });
  return database;
};

const cipher = {
  urlHost: "calendar.example.test",
  urlKeyId: "key-1",
  urlNonce: new Uint8Array(12).fill(1),
  urlCiphertext: new TextEncoder().encode("ciphertext-not-the-url"),
  urlTag: new Uint8Array(16).fill(2),
};

const settings = {
  name: "Team calendar",
  refreshIntervalMinutes: 120,
  color: "#4caf50",
  icon: null,
  includePattern: null,
  excludePattern: null,
  referenceOnly: false,
  autoImport: false,
  enabled: true,
  hidden: false,
};

const create = (
  database: SuiteDatabase,
  id = subscriptionId,
  ownerId = owner,
) =>
  database.calendarSubscriptions.create({
    ...settings,
    ...cipher,
    id,
    ownerId,
    nextFetchAt: now,
    now,
  });

const events = [
  {
    uid: "a",
    occurrenceStart: "2026-09-25T14:00:00.000Z",
    summary: "Standup",
    startsAt: "2026-09-25T14:00:00.000Z",
    endsAt: "2026-09-25T14:30:00.000Z",
    allDay: false,
    recurring: true,
    url: null,
  },
  {
    uid: "b",
    occurrenceStart: "2026-09-26",
    summary: "Holiday",
    startsAt: "2026-09-26T00:00:00.000Z",
    endsAt: "2026-09-27T00:00:00.000Z",
    allDay: true,
    recurring: false,
    url: "https://calendar.example.test/e/b",
  },
];
const window = [
  "2026-09-25T00:00:00.000Z",
  "2026-09-28T00:00:00.000Z",
] as const;

it("stores revisioned subscriptions, fetch outcomes and events per owner", async () => {
  await withTemporaryDirectory((directory) => {
    const database = open(directory);
    const store = database.calendarSubscriptions;
    const created = create(database);
    expect(created).toMatchObject({
      id: subscriptionId,
      ownerId: owner,
      revision: 1,
      name: "Team calendar",
      urlHost: "calendar.example.test",
      lastAttemptAt: null,
      eventCount: 0,
    });
    expect(store.list(owner)).toHaveLength(1);
    expect(store.list(other)).toHaveLength(0);
    expect(store.get(other, subscriptionId)).toBeUndefined();
    expect(store.count(owner)).toBe(1);

    const stale = store.update({
      ownerId: owner,
      id: subscriptionId,
      expectedRevision: 5,
      settings: { name: "Renamed" },
      now: later,
    });
    expect(stale.kind).toBe("conflict");
    expect(
      store.update({
        ownerId: other,
        id: subscriptionId,
        expectedRevision: 1,
        settings: { name: "Renamed" },
        now: later,
      }).kind,
    ).toBe("not_found");
    const updated = store.update({
      ownerId: owner,
      id: subscriptionId,
      expectedRevision: 1,
      settings: { name: "Renamed", includePattern: "stand", hidden: true },
      now: later,
    });
    expect(updated.kind === "updated" && updated.record).toMatchObject({
      revision: 2,
      name: "Renamed",
      includePattern: "stand",
      hidden: true,
      color: "#4caf50",
    });

    expect(store.listDue(now, 10).map(({ id }) => id)).toEqual([
      subscriptionId,
    ]);
    const failed = store.recordFetch({
      ownerId: owner,
      id: subscriptionId,
      outcome: { kind: "failed", errorClass: "http_not_found" },
      nextFetchAt: later,
      now,
    });
    expect(failed).toMatchObject({
      lastAttemptAt: now,
      lastSuccessAt: null,
      lastErrorClass: "http_not_found",
      nextFetchAt: later,
    });
    expect(store.listDue(now, 10)).toHaveLength(0);
    const fetched = store.recordFetch({
      ownerId: owner,
      id: subscriptionId,
      outcome: { kind: "fetched", events, etag: '"e1"', lastModified: null },
      nextFetchAt: later,
      now,
    });
    expect(fetched).toMatchObject({
      lastSuccessAt: now,
      lastErrorClass: null,
      etag: '"e1"',
      eventCount: 2,
      fetchRevision: 1,
    });
    expect(
      store.recordFetch({
        ownerId: owner,
        id: subscriptionId,
        outcome: { kind: "unchanged" },
        nextFetchAt: later,
        now: later,
      }),
    ).toMatchObject({ lastSuccessAt: later, eventCount: 2, fetchRevision: 1 });
    expect(
      store.recordFetch({
        ownerId: other,
        id: subscriptionId,
        outcome: { kind: "unchanged" },
        nextFetchAt: later,
        now: later,
      }),
    ).toBeUndefined();

    // The subscription is hidden: the projection excludes it, the owner list
    // still includes it on request.
    expect(database.listCalendarEvents(owner, ...window)).toHaveLength(0);
    expect(store.listEvents(owner, ...window)).toHaveLength(0);
    // The include filter applies on read: "Holiday" does not match "stand".
    expect(
      store
        .listEvents(owner, ...window, { includeHidden: true })
        .map(({ summary, subscriptionName }) => [summary, subscriptionName]),
    ).toEqual([["Standup", "Renamed"]]);
    store.update({
      ownerId: owner,
      id: subscriptionId,
      expectedRevision: 2,
      settings: { hidden: false, includePattern: null },
      now: later,
    });
    const projected = database.listCalendarEvents(owner, ...window);
    expect(projected.map((event) => event.summary)).toEqual([
      "Standup",
      "Holiday",
    ]);
    expect(projected[0]).toMatchObject({
      providerId: subscriptionId,
      calendarId: subscriptionId,
      href: "a#2026-09-25T14:00:00.000Z",
      etag: `"${now}"`,
      recurrence: "instance",
      providerKind: "ical",
      calendarName: "Renamed",
      rawIcs: "",
    });
    expect(database.listCalendarEvents(other, ...window)).toHaveLength(0);

    // Hidden events leave the projection but stay listed as hidden.
    expect(
      store.setEventHidden({
        ownerId: owner,
        subscriptionId,
        uid: "a",
        occurrenceStart: events[0]?.occurrenceStart ?? "",
        hidden: true,
        now,
      }),
    ).toBe(true);
    expect(
      store.setEventHidden({
        ownerId: other,
        subscriptionId,
        uid: "a",
        occurrenceStart: events[0]?.occurrenceStart ?? "",
        hidden: true,
        now,
      }),
    ).toBe(false);
    expect(
      database.listCalendarEvents(owner, ...window).map((e) => e.uid),
    ).toEqual(["b"]);
    expect(
      store
        .listEvents(owner, ...window, { includeHidden: true })
        .map(({ uid, hidden }) => [uid, hidden]),
    ).toEqual([
      ["a", true],
      ["b", false],
    ]);
    store.setEventHidden({
      ownerId: owner,
      subscriptionId,
      uid: "a",
      occurrenceStart: events[0]?.occurrenceStart ?? "",
      hidden: false,
      now,
    });
    expect(database.listCalendarEvents(owner, ...window)).toHaveLength(2);

    // A changed address discards the previous feed's events and state.
    const readdressed = store.update({
      ownerId: owner,
      id: subscriptionId,
      expectedRevision: 3,
      settings: {},
      cipher: { ...cipher, urlHost: "other.example.test" },
      nextFetchAt: now,
      now: later,
    });
    expect(readdressed.kind === "updated" && readdressed.record).toMatchObject({
      urlHost: "other.example.test",
      etag: null,
      lastSuccessAt: null,
      eventCount: 0,
      nextFetchAt: now,
    });
    expect(
      store.listEvents(owner, ...window, { includeHidden: true }),
    ).toHaveLength(0);

    expect(store.remove(other, subscriptionId, 4)).toBe("not_found");
    expect(store.remove(owner, subscriptionId, 1)).toBe("conflict");
    expect(store.remove(owner, subscriptionId, 4)).toBe("deleted");
    expect(store.list(owner)).toHaveLength(0);
    database.close();
  });
});

it("keeps conversions idempotent, tombstones dismissals and bounds hidden events", async () => {
  await withTemporaryDirectory((directory) => {
    const database = open(directory);
    const store = database.calendarSubscriptions;
    create(database);
    store.recordFetch({
      ownerId: owner,
      id: subscriptionId,
      outcome: { kind: "fetched", events, etag: null, lastModified: null },
      nextFetchAt: later,
      now,
    });
    const occurrence = events[0]?.occurrenceStart ?? "";
    const task = database.createTaskIdempotently(owner, "convert-a", "hash", {
      id: "44444444-4444-4444-8444-444444444444",
      title: "Standup",
      notes: "",
      status: "open",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    expect(task.kind).toBe("created");
    const taskId = task.kind === "created" ? task.task.id : "";
    store.recordConversion({
      ownerId: owner,
      subscriptionId,
      uid: "a",
      occurrenceStart: occurrence,
      taskId,
      kind: "manual",
      now,
    });
    expect(store.getConversion(owner, subscriptionId, "a", occurrence)).toEqual(
      {
        taskId,
        kind: "manual",
      },
    );
    expect(
      store.getConversion(other, subscriptionId, "a", occurrence),
    ).toBeUndefined();
    expect(store.conversionForTask(owner, taskId)).toEqual({
      subscriptionId,
      uid: "a",
      occurrenceStart: occurrence,
      kind: "manual",
    });
    // A dismissal never replaces a conversion.
    store.recordConversion({
      ownerId: owner,
      subscriptionId,
      uid: "a",
      occurrenceStart: occurrence,
      taskId: null,
      kind: "dismissed",
      now: later,
    });
    expect(
      store.getConversion(owner, subscriptionId, "a", occurrence)?.kind,
    ).toBe("manual");
    // A dismissal is a tombstone; a later conversion replaces it.
    store.recordConversion({
      ownerId: owner,
      subscriptionId,
      uid: "b",
      occurrenceStart: "2026-09-26",
      taskId: null,
      kind: "dismissed",
      now,
    });
    expect(
      store
        .listEvents(owner, ...window)
        .map(({ uid, taskId: linked, tombstoned }) => [
          uid,
          linked,
          tombstoned,
        ]),
    ).toEqual([
      ["a", taskId, true],
      ["b", null, true],
    ]);
    store.recordConversion({
      ownerId: owner,
      subscriptionId,
      uid: "b",
      occurrenceStart: "2026-09-26",
      taskId,
      kind: "auto_import",
      now: later,
    });
    expect(
      store.getConversion(owner, subscriptionId, "b", "2026-09-26"),
    ).toEqual({
      taskId,
      kind: "auto_import",
    });
    // Soft deletion keeps the provenance row (and the tombstone).
    expect(database.deleteTask(owner, taskId, 1, later).kind).toBe("updated");
    expect(
      store.getEvent(owner, subscriptionId, "a", occurrence),
    ).toMatchObject({
      taskId,
      tombstoned: true,
    });

    for (
      let index = 0;
      index < calendarSubscriptionHiddenEventLimit + 5;
      index += 1
    )
      store.setEventHidden({
        ownerId: owner,
        subscriptionId,
        uid: `hidden-${String(index)}`,
        occurrenceStart: "2026-01-01",
        hidden: true,
        now: new Date(Date.parse(now) + index * 1000).toISOString(),
      });
    const hiddenRows = database.calendarSubscriptions.listEvents(
      owner,
      ...window,
      {
        includeHidden: true,
      },
    );
    expect(hiddenRows).toHaveLength(2);
    expect(store.listAutoImport()).toHaveLength(0);
    store.update({
      ownerId: owner,
      id: subscriptionId,
      expectedRevision: 1,
      settings: { autoImport: true },
      now: later,
    });
    expect(store.listAutoImport().map(({ id }) => id)).toEqual([
      subscriptionId,
    ]);
    database.close();
  });
  // The hidden-event bound needs 1,000+ autocommitted writes; slow disks in
  // the shared test container need more than the default 5 s.
}, 30_000);

it("survives restart and backup without exposing the feed address", async () => {
  await withTemporaryDirectory((directory) => {
    const database = open(directory);
    create(database);
    database.calendarSubscriptions.recordFetch({
      ownerId: owner,
      id: subscriptionId,
      outcome: { kind: "fetched", events, etag: '"tag"', lastModified: null },
      nextFetchAt: later,
      now,
    });
    database.close();

    const reopened = open(directory);
    expect(reopened.state().appliedMigrationCount).toBe(46);
    expect(reopened.calendarSubscriptions.list(owner)[0]).toMatchObject({
      name: "Team calendar",
      eventCount: 2,
      etag: '"tag"',
    });
    const backupPath = join(directory, "backup.sqlite");
    reopened.backup(backupPath);
    reopened.close();
    const bytes = readFileSync(backupPath, "latin1");
    expect(bytes).toContain("ciphertext-not-the-url");
    expect(bytes).not.toContain(secretMarker);
    const restored = SuiteDatabase.open(backupPath);
    expect(
      restored.calendarSubscriptions.listEvents(owner, ...window),
    ).toHaveLength(2);
    expect(restored.calendarSubscriptions.list(owner)[0]?.urlHost).toBe(
      "calendar.example.test",
    );
    restored.close();
  });
});
