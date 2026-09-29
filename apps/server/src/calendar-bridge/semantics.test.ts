import { describe, expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import { calDavCollectionPath } from "./fakes.ts";
import {
  approve,
  googleTimed,
  harness,
  now,
  onlyBaikal,
  owner,
  type Harness,
} from "./harness.ts";

// Series, time zones, all-day dates and invitations through both fake
// providers (issue #45, ADR 0042).

const chicago = (wall: string, offset: string) => ({
  dateTime: `${wall}${offset}`,
  timeZone: "America/Chicago",
});

const ics = (...lines: string[]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Client//EN",
    ...lines,
    "END:VCALENDAR",
    "",
  ].join("\r\n");

const vevent = (uid: string, ...lines: string[]) => [
  "BEGIN:VEVENT",
  `UID:${uid}`,
  "DTSTAMP:20260901T000000Z",
  ...lines,
  "END:VEVENT",
];

/** Weekly Thursday standup at 10:00 Chicago; DST ends 2026-11-01. */
const standup = (uid: string, ...extra: readonly string[][]) =>
  ics(
    ...vevent(
      uid,
      "DTSTART;TZID=America/Chicago:20261022T100000",
      "DTEND;TZID=America/Chicago:20261022T110000",
      "SUMMARY:Standup",
      "RRULE:FREQ=WEEKLY;BYDAY=TH",
      "EXDATE;TZID=America/Chicago:20261029T100000",
    ),
    ...extra.flat(),
  );

const override = (uid: string, day: string, summary: string, hour = "14") =>
  vevent(
    uid,
    `RECURRENCE-ID;TZID=America/Chicago:202611${day}T100000`,
    `DTSTART;TZID=America/Chicago:202611${day}T${hour}0000`,
    `DTEND;TZID=America/Chicago:202611${day}T${String(Number(hour) + 1)}0000`,
    `SUMMARY:${summary}`,
  );

/** Runs passes and asserts they write nothing more (loop freedom). */
const settles = async (h: Harness, passes = 2) => {
  const writes = h.writes();
  for (let pass = 0; pass < passes; pass += 1)
    expect(await h.run()).toMatchObject({
      kind: "completed",
      counts: { enqueued: 0, applied: 0, conflicts: 0, blocked: 0 },
    });
  expect(h.writes()).toBe(writes);
};

const everyGoogleWriteIsSilent = (h: Harness) => {
  expect(h.google.writes.every((write) => write.sendUpdates === "none")).toBe(
    true,
  );
};

describe("bridge event semantics", () => {
  it("carries a zoned Google series across DST with instance edits and cancellations", async () => {
    await withTemporaryDirectory(async (directory) => {
      const h = harness(directory);
      h.google.userCreate("series1", {
        summary: "Standup",
        start: chicago("2026-10-22T10:00:00", "-05:00"),
        end: chicago("2026-10-22T11:00:00", "-05:00"),
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TH"],
      });
      expect(await h.run()).toMatchObject({ counts: { applied: 1 } });
      const copy = onlyBaikal(h);
      expect(copy.rawIcs).toContain("UID:series1@google.com");
      expect(copy.rawIcs).toContain(
        "DTSTART;TZID=America/Chicago:20261022T100000",
      );
      expect(copy.rawIcs).toContain("RRULE:FREQ=WEEKLY;BYDAY=TH");
      await settles(h);

      // Move the first instance after the DST change. Its Google instance
      // ID carries 16:00Z; its key stays 10:00 local.
      h.google.userEditInstance(
        "series1",
        "20261105T160000Z",
        chicago("2026-11-05T10:00:00", "-06:00"),
        {
          summary: "Standup (moved)",
          start: chicago("2026-11-05T14:00:00", "-06:00"),
          end: chicago("2026-11-05T15:00:00", "-06:00"),
        },
      );
      expect(await h.run()).toMatchObject({ counts: { applied: 1 } });
      let body = onlyBaikal(h).rawIcs;
      expect(body).toContain(
        "RECURRENCE-ID;TZID=America/Chicago:20261105T100000",
      );
      expect(body).toContain("DTSTART;TZID=America/Chicago:20261105T140000");
      expect(body).toContain("SUMMARY:Standup (moved)");
      await settles(h);

      // Deleting one instance is an explicit cancellation: no approval.
      h.google.userCancelInstance(
        "series1",
        "20261112T160000Z",
        chicago("2026-11-12T10:00:00", "-06:00"),
      );
      expect(await h.run()).toMatchObject({
        counts: { applied: 1, blocked: 0 },
      });
      body = onlyBaikal(h).rawIcs;
      expect(body).toContain("EXDATE;TZID=America/Chicago:20261112T100000");
      expect(body).toContain(
        "RECURRENCE-ID;TZID=America/Chicago:20261105T100000",
      );
      await settles(h);
      expect(h.links()).toHaveLength(1);
      expect(h.google.writes).toHaveLength(0);

      // Deleting the whole series still needs approval.
      h.google.userDelete("series1");
      expect(await h.run()).toMatchObject({ counts: { blocked: 1 } });
      expect(h.links()[0]?.statusReason).toBe("deletion-approval");
      approve(h, h.links()[0]?.id ?? "");
      expect(await h.run()).toMatchObject({ counts: { applied: 1 } });
      expect(h.baikal.resources.size).toBe(0);
    });
  });

  it("publishes a Baikal series to Google and follows instance edits on both sides", async () => {
    await withTemporaryDirectory(async (directory) => {
      const h = harness(directory);
      h.baikal.userPut(
        "standup.ics",
        standup("standup-uid", override("standup-uid", "05", "Moved")),
      );
      expect(await h.run()).toMatchObject({ counts: { applied: 1 } });
      const [link] = h.links();
      expect(link?.status).toBe("active");
      const id = link?.googleEventId ?? "";
      expect(h.google.events.get(id)).toMatchObject({
        start: { dateTime: "2026-10-22T10:00:00", timeZone: "America/Chicago" },
        recurrence: [
          "RRULE:FREQ=WEEKLY;BYDAY=TH",
          "EXDATE;TZID=America/Chicago:20261029T100000",
        ],
      });
      expect(h.google.events.get(`${id}_20261105T160000Z`)).toMatchObject({
        recurringEventId: id,
        summary: "Moved",
        originalStartTime: {
          dateTime: "2026-11-05T10:00:00",
          timeZone: "America/Chicago",
        },
      });
      await settles(h, 3);

      // Baikal: modify another instance.
      h.baikal.userPut(
        "standup.ics",
        standup(
          "standup-uid",
          override("standup-uid", "05", "Moved"),
          override("standup-uid", "19", "Retro", "09"),
        ),
      );
      expect(await h.run()).toMatchObject({ counts: { applied: 1 } });
      expect(h.google.events.get(`${id}_20261119T160000Z`)).toMatchObject({
        summary: "Retro",
        start: { dateTime: "2026-11-19T09:00:00" },
      });
      await settles(h);

      // Baikal: delete the moved instance (override removed, EXDATE added).
      h.baikal.userPut(
        "standup.ics",
        standup(
          "standup-uid",
          override("standup-uid", "19", "Retro", "09"),
        ).replace(
          "EXDATE;TZID=America/Chicago:20261029T100000",
          "EXDATE;TZID=America/Chicago:20261029T100000,20261105T100000",
        ),
      );
      expect(await h.run()).toMatchObject({ counts: { applied: 1 } });
      expect(h.google.events.get(`${id}_20261105T160000Z`)?.status).toBe(
        "cancelled",
      );
      expect(h.google.events.get(id)?.recurrence).toContain(
        "EXDATE;TZID=America/Chicago:20261029T100000,20261105T100000",
      );
      await settles(h);

      // Google: edit one instance of the published series.
      h.google.userEditInstance(
        id,
        "20261126T160000Z",
        chicago("2026-11-26T10:00:00", "-06:00"),
        {
          summary: "Holiday standup",
          start: chicago("2026-11-26T10:00:00", "-06:00"),
          end: chicago("2026-11-26T10:30:00", "-06:00"),
        },
      );
      expect(await h.run()).toMatchObject({ counts: { applied: 1 } });
      const body = onlyBaikal(h).rawIcs;
      expect(body).toContain(
        "RECURRENCE-ID;TZID=America/Chicago:20261126T100000",
      );
      expect(body).toContain("DTEND;TZID=America/Chicago:20261126T103000");
      expect(body).toContain("SUMMARY:Retro");
      expect(body).not.toContain("SUMMARY:Moved");
      await settles(h);
      expect(h.links()).toHaveLength(1);
      expect(h.google.events.get(id)?.status).toBe("confirmed");

      // Deleting the whole series on Baikal needs approval, then cancels
      // the Google master and its exceptions.
      h.baikal.userDelete(`${calDavCollectionPath}standup.ics`);
      expect(await h.run()).toMatchObject({ counts: { blocked: 1 } });
      expect(h.google.events.get(id)?.status).toBe("confirmed");
      approve(h, h.links()[0]?.id ?? "");
      expect(await h.run()).toMatchObject({ counts: { applied: 1 } });
      expect(
        [...h.google.events.values()].map((event) => event.status),
      ).toEqual(["cancelled", "cancelled", "cancelled", "cancelled"]);
      expect(h.links()[0]?.status).toBe("tombstoned");
      everyGoogleWriteIsSilent(h);
    });
  });

  it("keeps all-day series and events on dates in both directions", async () => {
    await withTemporaryDirectory(async (directory) => {
      const h = harness(directory);
      h.google.userCreate("newyear", {
        summary: "New Year's Eve",
        start: { date: "2026-12-31" },
        end: { date: "2027-01-01" },
        recurrence: ["RRULE:FREQ=YEARLY"],
      });
      await h.run();
      expect(onlyBaikal(h).rawIcs).toContain("DTSTART;VALUE=DATE:20261231");
      expect(onlyBaikal(h).rawIcs).toContain("DTEND;VALUE=DATE:20270101");
      h.google.userCancelInstance("newyear", "20271231", {
        date: "2027-12-31",
      });
      expect(await h.run()).toMatchObject({ counts: { applied: 1 } });
      expect(onlyBaikal(h).rawIcs).toContain("EXDATE;VALUE=DATE:20271231");
      await settles(h);

      // A Baikal all-day event without DTEND lasts one day.
      h.baikal.userPut(
        "day.ics",
        ics(...vevent("day-uid", "DTSTART;VALUE=DATE:20261002", "SUMMARY:Off")),
      );
      await h.run();
      const dayLink = h.links().find((link) => link.origin === "baikal");
      expect(h.google.events.get(dayLink?.googleEventId ?? "")).toMatchObject({
        start: { date: "2026-10-02" },
        end: { date: "2026-10-03" },
      });
      await settles(h);
    });
  });

  it("resumes a series create whose response was lost without duplicates", async () => {
    await withTemporaryDirectory(async (directory) => {
      const h = harness(directory);
      h.baikal.userPut(
        "lost.ics",
        standup("lost-uid", override("lost-uid", "05", "Moved")),
      );
      h.google.loseNextWriteResponse();
      expect(await h.run()).toMatchObject({ counts: { uncertain: 1 } });
      await h.run();
      await h.run();
      const [link] = h.links();
      expect(link?.status).toBe("active");
      const id = link?.googleEventId ?? "";
      expect(
        h.google.writes.filter((write) => write.method === "POST"),
      ).toHaveLength(1);
      expect(h.google.events.get(`${id}_20261105T160000Z`)?.summary).toBe(
        "Moved",
      );
      expect(h.google.events.size).toBe(2);
      await settles(h);
    });
  });

  it("mirrors a Google invitation read-only and never writes the invitation", async () => {
    await withTemporaryDirectory(async (directory) => {
      const h = harness(directory);
      const attendees = (response: string) => [
        { email: "owner@example.test", self: true, responseStatus: response },
        { email: "boss@example.test", organizer: true },
      ];
      h.google.userCreate("meeting1", {
        ...googleTimed("Planning"),
        organizer: { email: "boss@example.test", displayName: "Boss" },
        attendees: attendees("needsAction"),
      });
      expect(await h.run()).toMatchObject({ counts: { applied: 1 } });
      const copy = onlyBaikal(h);
      expect(copy.rawIcs).toContain("SUMMARY:Planning");
      expect(copy.rawIcs).not.toMatch(/ORGANIZER|ATTENDEE|boss@/);
      const [link] = h.links();
      expect(link).toMatchObject({ status: "active" });
      // The retained Google snapshot keeps the invitation for review.
      expect(link?.google.snapshot).toContain("boss@example.test");
      await settles(h);

      // A response change alone is not bridge content.
      h.google.userUpdate("meeting1", { attendees: attendees("accepted") });
      await settles(h, 1);

      // The organizer moves the meeting: the copy follows.
      h.google.userUpdate("meeting1", googleTimed("Planning", 17));
      expect(await h.run()).toMatchObject({ counts: { applied: 1 } });
      expect(onlyBaikal(h).rawIcs).toContain("DTSTART:20261001T170000Z");

      // Editing the copy never changes the organizer's event.
      const name = copy.href.slice(calDavCollectionPath.length);
      h.baikal.userPut(
        name,
        ics(
          ...vevent(
            "meeting1@google.com",
            "DTSTART:20261001T170000Z",
            "DTEND:20261001T180000Z",
            "SUMMARY:My notes",
          ),
        ),
      );
      expect(await h.run()).toMatchObject({ counts: { blocked: 1 } });
      expect(h.links()[0]).toMatchObject({
        status: "blocked",
        statusReason: "invitation",
      });

      // Both changed: a conflict. Keeping the copy is refused at dispatch.
      h.google.userUpdate("meeting1", googleTimed("Planning v2", 17));
      expect(await h.run()).toMatchObject({ counts: { conflicts: 1 } });
      const [conflict] = h.database.calendarBridge.listOpenConflicts(
        h.mappingId,
      );
      expect(
        h.database.calendarBridge.resolveConflict({
          ownerId: owner,
          mappingId: h.mappingId,
          conflictId: conflict?.id ?? "",
          keep: "baikal",
          operationId: "44444444-4444-4444-8444-444444444444",
          now,
        }).kind,
      ).toBe("resolved");
      await h.run();
      expect(
        h.database.calendarBridge.getOperation(
          "44444444-4444-4444-8444-444444444444",
        ),
      ).toMatchObject({ state: "failed", lastError: "invitation-read-only" });
      expect(h.google.writes).toHaveLength(0);
      expect(h.google.events.get("meeting1")?.summary).toBe("Planning v2");
    });
  });

  it("copies a Baikal event with attendees to Google without them", async () => {
    await withTemporaryDirectory(async (directory) => {
      const h = harness(directory);
      h.baikal.userPut(
        "invite.ics",
        ics(
          ...vevent(
            "invite-uid",
            "DTSTART:20261001T150000Z",
            "DTEND:20261001T160000Z",
            "SUMMARY:Review",
            "ORGANIZER;CN=Owner:mailto:owner@example.test",
            "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:guest@example.test",
          ),
        ),
      );
      expect(await h.run()).toMatchObject({ counts: { applied: 1 } });
      const id = h.links()[0]?.googleEventId ?? "";
      const event = h.google.events.get(id);
      expect(event?.summary).toBe("Review");
      expect(event?.attendees).toBeUndefined();
      expect(event?.organizer).toMatchObject({ self: true });
      everyGoogleWriteIsSilent(h);
      await settles(h);
    });
  });

  it("keeps unsupported data blocked and visible with its field names", async () => {
    await withTemporaryDirectory(async (directory) => {
      const h = harness(directory);
      h.baikal.userPut(
        "alarm.ics",
        ics(
          ...vevent(
            "alarm-uid",
            "DTSTART:20261001T150000Z",
            "DTEND:20261001T160000Z",
            "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC",
            "BEGIN:VALARM",
            "ACTION:DISPLAY",
            "TRIGGER:-PT15M",
            "END:VALARM",
          ),
        ),
      );
      h.baikal.userPut(
        "floating.ics",
        ics(
          ...vevent(
            "floating-uid",
            "DTSTART:20261001T150000",
            "DTEND:20261001T160000",
          ),
        ),
      );
      // An instance of a series that is not in this calendar.
      h.google.userCreate("foreign_20261001T150000Z", {
        ...googleTimed("One instance"),
        recurringEventId: "foreign",
        originalStartTime: { dateTime: "2026-10-01T15:00:00Z" },
      });
      await h.run();
      expect(h.writes()).toBe(0);
      const fields = (href: string) => {
        const link = h
          .links()
          .find(
            (item) => item.baikalHref === href || item.googleEventId === href,
          );
        expect(link).toMatchObject({
          status: "blocked",
          statusReason: "unsupported",
          acceptedKind: "none",
        });
        const side = link?.origin === "google" ? link.google : link?.baikal;
        return Object.keys(
          (JSON.parse(side?.snapshot ?? "{}") as { unsupported: object })
            .unsupported,
        ).toSorted();
      };
      expect(fields(`${calDavCollectionPath}alarm.ics`)).toEqual([
        "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR",
        "alarms",
      ]);
      expect(fields(`${calDavCollectionPath}floating.ics`)).toEqual([
        "timezone",
      ]);
      expect(fields("foreign_20261001T150000Z")).toEqual([
        "recurring-instance",
      ]);
      await h.run();
      expect(h.writes()).toBe(0);
    });
  });
});
