import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import {
  SuiteDatabase,
  type CalendarBridgeDirectionName,
  type CalendarBridgeInitialSync,
} from "@suite/persistence";
import { runBridgeOnce } from "./engine.ts";
import {
  calDavCollectionPath,
  createFakeCalDav,
  createFakeGoogleCalendar,
  vevent,
  type FakeCalDav,
  type FakeGoogleCalendar,
} from "./fakes.ts";
import { createCalDavBridgeSide, createGoogleBridgeSide } from "./providers.ts";

// End-to-end passes against fake providers (issue #40, ADR 0041).
const owner = "11111111-1111-4111-8111-111111111111";
const now = "2026-09-25T12:00:00.000Z";

interface Harness {
  readonly google: FakeGoogleCalendar;
  readonly baikal: FakeCalDav;
  database: SuiteDatabase;
  readonly mappingId: string;
  run(): ReturnType<typeof runBridgeOnce>;
  reopen(): void;
  links(): ReturnType<SuiteDatabase["calendarBridge"]["listLinks"]>;
  writes(): number;
}

const harness = (
  directory: string,
  options: {
    readonly direction?: CalendarBridgeDirectionName;
    readonly initialSync?: CalendarBridgeInitialSync;
  } = {},
): Harness => {
  const path = join(directory, "suite.sqlite");
  const google = createFakeGoogleCalendar();
  const baikal = createFakeCalDav();
  let database = SuiteDatabase.open(path);
  database.createOwner({
    id: owner,
    username: "owner",
    displayName: "Owner",
    passwordHash: "hash",
    createdAt: now,
  });
  const googleProvider = database.ensureCalendarProvider(
    owner,
    "google",
    "google-connector",
    now,
  );
  const [googleCalendar] = database.putCalendarCollections(
    googleProvider.id,
    [
      {
        href: google.calendarId,
        displayName: "Primary",
        supportsEvents: true,
        supportsTodos: false,
      },
    ],
    now,
  );
  const baikalProvider = database.ensureCalendarProvider(
    owner,
    "baikal",
    "baikal-connector",
    now,
  );
  const [baikalCalendar] = database.putCalendarCollections(
    baikalProvider.id,
    [
      {
        href: calDavCollectionPath,
        displayName: "Work",
        supportsEvents: true,
        supportsTodos: false,
      },
    ],
    now,
  );
  const created = database.calendarBridge.createMapping({
    id: "22222222-2222-4222-8222-222222222222",
    ownerId: owner,
    googleCalendarId: googleCalendar?.id ?? "",
    baikalCalendarId: baikalCalendar?.id ?? "",
    direction: options.direction ?? "two_way",
    initialSync: options.initialSync ?? "copy_existing",
    now,
  });
  if (created.kind !== "created") throw new Error(created.kind);
  const h: Harness = {
    google,
    baikal,
    database,
    mappingId: created.mapping.id,
    run: () => {
      const mapping = h.database.calendarBridge.getMapping(owner, h.mappingId);
      if (mapping === undefined) throw new Error("mapping missing");
      return runBridgeOnce({
        store: h.database.calendarBridge,
        mapping,
        now,
        google: createGoogleBridgeSide({
          accessToken: "bridge-access",
          calendarId: google.calendarId,
          fetch: google.fetch,
        }),
        baikal: createCalDavBridgeSide({
          collectionUrl: new URL(`http://baikal.test${calDavCollectionPath}`),
          username: "alice",
          password: "secret",
          now,
          fetch: baikal.fetch,
        }),
      });
    },
    reopen: () => {
      h.database.close();
      database = SuiteDatabase.open(path);
      h.database = database;
    },
    links: () => h.database.calendarBridge.listLinks(h.mappingId),
    writes: () => google.writes.length + baikal.writes.length,
  };
  return h;
};

const googleTimed = (summary: string, hour = 15) => ({
  summary,
  start: { dateTime: `2026-10-01T${String(hour)}:00:00Z`, timeZone: "UTC" },
  end: { dateTime: `2026-10-01T${String(hour + 1)}:00:00Z`, timeZone: "UTC" },
});

const onlyBaikal = (h: Harness) => {
  expect(h.baikal.resources.size).toBe(1);
  const [entry] = [...h.baikal.resources.entries()];
  if (entry === undefined) throw new Error("no Baikal resource");
  return { href: entry[0], ...entry[1] };
};

const approve = (h: Harness, linkId: string) => {
  const link = h.database.calendarBridge.getLink(linkId);
  const result = h.database.calendarBridge.approveDeletion({
    ownerId: owner,
    mappingId: h.mappingId,
    linkId,
    expectedRevision: link?.revision ?? 0,
    now,
  });
  expect(result.kind).toBe("approved");
};

describe("calendar bridge passes", () => {
  it("copies a Google event to Baikal once and suppresses the echo", async () => {
    await withTemporaryDirectory(async (directory) => {
      const h = harness(directory);
      h.google.userCreate("evtgoogle1", googleTimed("Dentist"));
      const first = await h.run();
      expect(first).toMatchObject({
        kind: "completed",
        counts: { enqueued: 1, applied: 1 },
      });
      const copy = onlyBaikal(h);
      expect(copy.rawIcs).toContain("UID:evtgoogle1@google.com");
      expect(copy.rawIcs).toContain("SUMMARY:Dentist");
      expect(copy.rawIcs).toContain("DTSTART:20261001T150000Z");
      const [link] = h.links();
      expect(link).toMatchObject({
        origin: "google",
        status: "active",
        acceptedKind: "present",
        googleEventId: "evtgoogle1",
        baikalHref: copy.href,
        baikalUid: "evtgoogle1@google.com",
        baikal: { kind: "present", revision: copy.etag },
      });
      const writes = h.writes();
      // The copy now appears in Baikal and (unchanged) Google again: no work.
      for (let pass = 0; pass < 3; pass += 1)
        expect(await h.run()).toMatchObject({
          kind: "completed",
          counts: { enqueued: 0, applied: 0, conflicts: 0 },
        });
      expect(h.writes()).toBe(writes);
      expect(h.links()).toHaveLength(1);
      expect(h.baikal.resources.size).toBe(1);
    });
  });

  it("publishes a Baikal event to Google under a reserved ID", async () => {
    await withTemporaryDirectory(async (directory) => {
      const h = harness(directory);
      h.baikal.userPut(
        "client.ics",
        vevent({
          uid: "client-uid",
          summary: "Standup, daily; notes",
          extra: ["DESCRIPTION:Line one\\nLine two", "LOCATION:Room 4"],
        }),
      );
      await h.run();
      const [link] = h.links();
      expect(link?.origin).toBe("baikal");
      expect(link?.status).toBe("active");
      const googleId = link?.googleEventId ?? "";
      expect(googleId).toBe((link?.id ?? "").replaceAll("-", ""));
      expect(h.google.events.get(googleId)).toMatchObject({
        summary: "Standup, daily; notes",
        description: "Line one\nLine two",
        location: "Room 4",
        start: { dateTime: "2026-10-01T15:00:00.000Z" },
      });
      const writes = h.writes();
      await h.run();
      await h.run();
      expect(h.writes()).toBe(writes);
      expect(h.google.events.size).toBe(1);
    });
  });

  it("propagates updates in both directions with the observed revision", async () => {
    await withTemporaryDirectory(async (directory) => {
      const h = harness(directory);
      h.google.userCreate("evtupdate1", googleTimed("Plan"));
      await h.run();
      h.google.userUpdate("evtupdate1", googleTimed("Plan (moved)", 17));
      expect(await h.run()).toMatchObject({ counts: { applied: 1 } });
      expect(onlyBaikal(h).rawIcs).toContain("SUMMARY:Plan (moved)");
      expect(onlyBaikal(h).rawIcs).toContain("DTSTART:20261001T170000Z");
      const baikalWrite = h.baikal.writes.at(-1);
      expect(baikalWrite?.method).toBe("PUT");

      const copy = onlyBaikal(h);
      h.baikal.userPut(
        copy.href.slice(calDavCollectionPath.length),
        vevent({
          uid: "evtupdate1@google.com",
          summary: "Plan (edited in Baikal)",
          start: "20261001T170000Z",
          end: "20261001T180000Z",
        }),
      );
      expect(await h.run()).toMatchObject({ counts: { applied: 1 } });
      expect(h.google.events.get("evtupdate1")?.summary).toBe(
        "Plan (edited in Baikal)",
      );
      expect(h.google.writes.at(-1)).toEqual({
        method: "PUT",
        id: "evtupdate1",
      });
      const writes = h.writes();
      await h.run();
      expect(h.writes()).toBe(writes);
      expect(h.links()[0]?.status).toBe("active");
    });
  });

  it("requires approval before propagating a deletion and never resurrects", async () => {
    await withTemporaryDirectory(async (directory) => {
      const h = harness(directory);
      h.google.userCreate("evtdelete1", googleTimed("Cancelled meeting"));
      await h.run();
      const linkId = h.links()[0]?.id ?? "";
      h.google.userDelete("evtdelete1");
      expect(await h.run()).toMatchObject({ counts: { blocked: 1 } });
      expect(h.baikal.resources.size).toBe(1);
      expect(h.links()[0]).toMatchObject({
        status: "blocked",
        statusReason: "deletion-approval",
      });
      approve(h, linkId);
      expect(await h.run()).toMatchObject({ counts: { applied: 1 } });
      expect(h.baikal.resources.size).toBe(0);
      expect(h.links()[0]).toMatchObject({
        status: "tombstoned",
        acceptedKind: "deleted",
      });
      const writes = h.writes();
      await h.run();
      expect(h.writes()).toBe(writes);
      // The Google event comes back (e.g. an undo): reviewed, not revived.
      h.google.userRestore("evtdelete1");
      expect(await h.run()).toMatchObject({ counts: { conflicts: 1 } });
      expect(h.baikal.resources.size).toBe(0);
      expect(
        h.database.calendarBridge.listOpenConflicts(h.mappingId)[0],
      ).toMatchObject({ reason: "resurrection" });
      expect(h.writes()).toBe(writes);
    });
  });

  it("propagates an approved Baikal deletion to Google as a cancellation", async () => {
    await withTemporaryDirectory(async (directory) => {
      const h = harness(directory);
      const href = h.baikal.userPut(
        "gone.ics",
        vevent({ uid: "gone-uid", summary: "Gone" }),
      );
      await h.run();
      const link = h.links()[0];
      h.baikal.userDelete(href);
      await h.run();
      approve(h, link?.id ?? "");
      await h.run();
      expect(h.google.events.get(link?.googleEventId ?? "")?.status).toBe(
        "cancelled",
      );
      expect(h.links()[0]?.status).toBe("tombstoned");
    });
  });

  it("keeps both sides of a concurrent edit until the owner resolves it", async () => {
    await withTemporaryDirectory(async (directory) => {
      const h = harness(directory);
      h.google.userCreate("evtconflict", googleTimed("Original"));
      await h.run();
      const copy = onlyBaikal(h);
      h.google.userUpdate("evtconflict", googleTimed("Google edit"));
      h.baikal.userPut(
        copy.href.slice(calDavCollectionPath.length),
        vevent({ uid: "evtconflict@google.com", summary: "Baikal edit" }),
      );
      const writes = h.writes();
      for (let pass = 0; pass < 2; pass += 1)
        expect(await h.run()).toMatchObject({ counts: { conflicts: 1 } });
      expect(h.writes()).toBe(writes);
      expect(h.google.events.get("evtconflict")?.summary).toBe("Google edit");
      expect(onlyBaikal(h).rawIcs).toContain("SUMMARY:Baikal edit");
      const conflicts = h.database.calendarBridge.listOpenConflicts(
        h.mappingId,
      );
      expect(conflicts).toHaveLength(1);
      const resolved = h.database.calendarBridge.resolveConflict({
        ownerId: owner,
        mappingId: h.mappingId,
        conflictId: conflicts[0]?.id ?? "",
        keep: "google",
        operationId: "33333333-3333-4333-8333-333333333333",
        now,
      });
      expect(resolved.kind).toBe("resolved");
      expect(await h.run()).toMatchObject({ counts: { applied: 1 } });
      expect(onlyBaikal(h).rawIcs).toContain("SUMMARY:Google edit");
      expect(h.links()[0]?.status).toBe("active");
      const settled = h.writes();
      await h.run();
      expect(h.writes()).toBe(settled);
    });
  });

  it("reconciles a write whose response was lost without sending it twice", async () => {
    await withTemporaryDirectory(async (directory) => {
      const h = harness(directory);
      h.google.userCreate("evtlost", googleTimed("Lost response"));
      h.baikal.loseNextWriteResponse();
      expect(await h.run()).toMatchObject({ counts: { uncertain: 1 } });
      expect(
        h.database.calendarBridge.listUnfinishedOperations(h.mappingId)[0]
          ?.state,
      ).toBe("uncertain");
      // Remove uncertain work is refused until reconciled.
      const mapping = h.database.calendarBridge.getMapping(owner, h.mappingId);
      expect(
        h.database.calendarBridge.removeMapping({
          ownerId: owner,
          mappingId: h.mappingId,
          expectedRevision: mapping?.revision ?? 0,
          cancelPending: true,
          now,
        }),
      ).toBe("in-flight");
      h.reopen();
      const puts = h.baikal.writes.length;
      expect(await h.run()).toMatchObject({ counts: { applied: 1 } });
      expect(h.baikal.writes.length).toBe(puts);
      expect(h.baikal.resources.size).toBe(1);
      expect(h.links()[0]?.status).toBe("active");

      // Google side: the insert commits, the response is lost.
      h.baikal.userPut("second.ics", vevent({ uid: "second", summary: "B" }));
      h.google.loseNextWriteResponse();
      await h.run();
      const inserts = h.google.writes.length;
      await h.run();
      expect(h.google.writes.length).toBe(inserts);
      expect(h.google.events.size).toBe(2);
    });
  });

  it("reads the target before resending work marked dispatched before a crash", async () => {
    await withTemporaryDirectory(async (directory) => {
      const h = harness(directory);
      h.google.userCreate("evtcrash", googleTimed("Crash"));
      h.baikal.rejectWrites(401);
      await h.run();
      const [pending] = h.database.calendarBridge.listUnfinishedOperations(
        h.mappingId,
      );
      expect(pending).toMatchObject({
        state: "pending",
        lastError: "baikal-authentication-required",
      });
      // Crash after the durable dispatch mark, before the request was sent.
      expect(
        h.database.calendarBridge.markDispatched(pending?.id ?? "", now),
      ).toBe(true);
      h.reopen();
      h.baikal.rejectWrites(null);
      expect(await h.run()).toMatchObject({ counts: { applied: 1 } });
      expect(h.baikal.writes).toHaveLength(1);
      expect(
        h.database.calendarBridge.getOperation(pending?.id ?? ""),
      ).toMatchObject({ state: "applied", attempts: 3 });
      expect(onlyBaikal(h).rawIcs).toContain("SUMMARY:Crash");
    });
  });

  it("recovers from a Google cursor reset and an outage without duplicates", async () => {
    await withTemporaryDirectory(async (directory) => {
      const h = harness(directory);
      h.google.userCreate("evtreset", googleTimed("Reset"));
      h.baikal.userPut("reset.ics", vevent({ uid: "reset-b", summary: "B" }));
      await h.run();
      const writes = h.writes();
      const cursor = h.database.calendarBridge.getMapping(
        owner,
        h.mappingId,
      )?.googleCursor;
      h.google.setUnavailable(true);
      expect(await h.run()).toMatchObject({
        kind: "failed",
        reason: "google-unavailable",
      });
      expect(
        h.database.calendarBridge.getMapping(owner, h.mappingId)?.googleCursor,
      ).toBe(cursor);
      h.google.setUnavailable(false);
      h.google.expireSyncTokens();
      expect(await h.run()).toMatchObject({
        kind: "completed",
        counts: { enqueued: 0 },
      });
      expect(h.writes()).toBe(writes);
      expect(h.links()).toHaveLength(2);
      expect(h.google.events.size).toBe(2);
      expect(h.baikal.resources.size).toBe(2);
    });
  });

  it("excludes existing events for new-only mappings and copies later ones", async () => {
    await withTemporaryDirectory(async (directory) => {
      const h = harness(directory, { initialSync: "new_only" });
      h.google.userCreate("evtold", googleTimed("Old"));
      h.baikal.userPut("old.ics", vevent({ uid: "old-b", summary: "Old B" }));
      expect(await h.run()).toMatchObject({ counts: { excluded: 2 } });
      expect(h.writes()).toBe(0);
      h.google.userCreate("evtnew", googleTimed("New"));
      h.google.userUpdate("evtold", googleTimed("Old, edited"));
      await h.run();
      expect(h.baikal.resources.size).toBe(2);
      expect(
        [...h.baikal.resources.values()].some((r) =>
          r.rawIcs.includes("SUMMARY:New"),
        ),
      ).toBe(true);
    });
  });

  it("blocks unsupported content, identity collisions and disallowed directions", async () => {
    await withTemporaryDirectory(async (directory) => {
      const h = harness(directory, { direction: "google_to_baikal" });
      h.google.userCreate("evtrecurring", {
        ...googleTimed("Weekly"),
        recurrence: ["RRULE:FREQ=WEEKLY"],
      });
      h.google.userCreate("evtinvite", {
        ...googleTimed("Invite"),
        attendees: [{ email: "guest@example.test" }],
      });
      h.google.userCreate("evtsame", {
        ...googleTimed("Same UID"),
        iCalUID: "shared-uid",
      });
      h.baikal.userPut("same.ics", vevent({ uid: "shared-uid" }));
      h.baikal.userPut("local.ics", vevent({ uid: "local-only" }));
      await h.run();
      expect(h.writes()).toBe(0);
      const reasons: Record<string, string | null> = Object.fromEntries(
        h
          .links()
          .map((link) => [
            link.googleEventId ?? link.baikalHref ?? "",
            link.statusReason,
          ]),
      );
      expect(reasons).toMatchObject({
        evtrecurring: "unsupported",
        evtinvite: "unsupported",
        evtsame: "identity-collision",
        [`${calDavCollectionPath}local.ics`]: "direction",
      });
      await h.run();
      expect(h.writes()).toBe(0);
    });
  });

  it("does nothing for a disabled mapping and keeps its state", async () => {
    await withTemporaryDirectory(async (directory) => {
      const h = harness(directory);
      h.google.userCreate("evtoff", googleTimed("Off"));
      const mapping = h.database.calendarBridge.getMapping(owner, h.mappingId);
      h.database.calendarBridge.setMappingEnabled({
        ownerId: owner,
        mappingId: h.mappingId,
        expectedRevision: mapping?.revision ?? 0,
        enabled: false,
        now,
      });
      expect(await h.run()).toEqual({ kind: "disabled" });
      expect(h.writes()).toBe(0);
    });
  });
});
