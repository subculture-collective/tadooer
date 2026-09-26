import { describe, expect, it } from "vitest";
import { parseIcalFeed } from "./ical-feed.ts";

const calendar = (...events: readonly string[]): string =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//EN",
    ...events.flatMap((event) => [
      "BEGIN:VEVENT",
      ...event.split("\n"),
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
    "",
  ].join("\r\n");

const window = {
  from: "2026-09-01T00:00:00.000Z",
  to: "2026-10-31T00:00:00.000Z",
  timeZone: "America/Chicago",
};

describe("parseIcalFeed", () => {
  it("parses UTC, zoned, floating and all-day events with DTEND or DURATION", () => {
    const result = parseIcalFeed(
      calendar(
        "UID:utc\nSUMMARY:Standup\\, daily\nDTSTART:20260910T140000Z\nDTEND:20260910T143000Z",
        "UID:zoned\nSUMMARY:Zoned\nDTSTART;TZID=Europe/Berlin:20260910T090000\nDURATION:PT45M",
        "UID:floating\nSUMMARY:Floating\nDTSTART:20260910T080000\nDTEND:20260910T090000",
        "UID:allday\nSUMMARY:Holiday\nDTSTART;VALUE=DATE:20260912\nDTEND;VALUE=DATE:20260914",
        "UID:zero\nSUMMARY:Zero length\nDTSTART:20260910T200000Z",
        "UID:folded\nSUMMARY:A long summary that is\n  folded across lines\nDTSTART:20260911T100000Z\nDTEND:20260911T110000Z\nURL:https://calendar.example.test/e/1",
      ),
      window,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byUid = new Map(result.events.map((event) => [event.uid, event]));
    expect(byUid.get("utc")).toMatchObject({
      summary: "Standup, daily",
      startsAt: "2026-09-10T14:00:00.000Z",
      endsAt: "2026-09-10T14:30:00.000Z",
      allDay: false,
      recurring: false,
      occurrenceStart: "2026-09-10T14:00:00.000Z",
    });
    expect(byUid.get("zoned")).toMatchObject({
      startsAt: "2026-09-10T07:00:00.000Z",
      endsAt: "2026-09-10T07:45:00.000Z",
    });
    expect(byUid.get("floating")).toMatchObject({
      startsAt: "2026-09-10T13:00:00.000Z",
      endsAt: "2026-09-10T14:00:00.000Z",
    });
    expect(byUid.get("allday")).toMatchObject({
      allDay: true,
      occurrenceStart: "2026-09-12",
      startsAt: "2026-09-12T00:00:00.000Z",
      endsAt: "2026-09-14T00:00:00.000Z",
    });
    expect(byUid.get("zero")).toMatchObject({
      endsAt: "2026-09-10T20:01:00.000Z",
    });
    expect(byUid.get("folded")).toMatchObject({
      summary: "A long summary that is folded across lines",
      url: "https://calendar.example.test/e/1",
    });
    expect(result.counts).toMatchObject({ components: 6, invalid: 0 });
  });

  it("expands supported RRULEs inside the window with EXDATE, UNTIL, COUNT and overrides", () => {
    const result = parseIcalFeed(
      calendar(
        "UID:weekly\nSUMMARY:Weekly\nDTSTART;TZID=America/Chicago:20260901T090000\nDTEND;TZID=America/Chicago:20260901T100000\nRRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20260930T235959Z\nEXDATE;TZID=America/Chicago:20260908T090000",
        "UID:weekly\nSUMMARY:Weekly (moved)\nRECURRENCE-ID;TZID=America/Chicago:20260910T090000\nDTSTART;TZID=America/Chicago:20260911T130000\nDTEND;TZID=America/Chicago:20260911T140000",
        "UID:weekly\nSUMMARY:Weekly (cancelled)\nRECURRENCE-ID;TZID=America/Chicago:20260915T090000\nDTSTART;TZID=America/Chicago:20260915T090000\nDTEND;TZID=America/Chicago:20260915T100000\nSTATUS:CANCELLED",
        "UID:monthly\nSUMMARY:Second Monday\nDTSTART:20260601T100000Z\nDTEND:20260601T110000Z\nRRULE:FREQ=MONTHLY;BYDAY=2MO",
        "UID:count\nSUMMARY:Daily three\nDTSTART:20260929T100000Z\nDTEND:20260929T103000Z\nRRULE:FREQ=DAILY;COUNT=3",
        "UID:old\nSUMMARY:Ended long ago\nDTSTART:20200101T100000Z\nDTEND:20200101T110000Z\nRRULE:FREQ=DAILY;COUNT=5",
        "UID:allday\nSUMMARY:Monthly all-day\nDTSTART;VALUE=DATE:20260131\nRRULE:FREQ=MONTHLY;INTERVAL=1",
        "UID:unsupported\nSUMMARY:Hourly\nDTSTART:20260905T100000Z\nDTEND:20260905T110000Z\nRRULE:FREQ=HOURLY;INTERVAL=2",
      ),
      window,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const of = (uid: string) =>
      result.events.filter((event) => event.uid === uid);
    const weekly = of("weekly");
    // Tuesdays and Thursdays in September 2026: 1,3,8,10,15,17,22,24,29.
    // 8 is excluded, 15 cancelled and 10 moved to the 11th.
    expect(weekly.map((event) => event.startsAt.slice(0, 10))).toEqual([
      "2026-09-01",
      "2026-09-03",
      "2026-09-11",
      "2026-09-17",
      "2026-09-22",
      "2026-09-24",
      "2026-09-29",
    ]);
    const moved = weekly.find((event) => event.summary === "Weekly (moved)");
    expect(moved).toMatchObject({
      occurrenceStart: "2026-09-10T14:00:00.000Z",
      startsAt: "2026-09-11T18:00:00.000Z",
      recurring: true,
    });
    expect(
      weekly.every(
        (event) => event.startsAt.endsWith("T14:00:00.000Z") || event === moved,
      ),
    ).toBe(true);
    expect(of("monthly").map((event) => event.startsAt.slice(0, 10))).toEqual([
      "2026-09-14",
      "2026-10-12",
    ]);
    expect(of("count")).toHaveLength(3);
    expect(of("old")).toHaveLength(0);
    // The 31st does not exist in September, so that month is skipped and
    // October's occurrence starts exactly at the window end (exclusive).
    expect(of("allday")).toHaveLength(0);
    const allDay = parseIcalFeed(
      calendar(
        "UID:allday\nSUMMARY:Monthly all-day\nDTSTART;VALUE=DATE:20260131\nRRULE:FREQ=MONTHLY;INTERVAL=1",
      ),
      { ...window, to: "2026-11-01T00:00:00.000Z" },
    );
    expect(
      allDay.ok && allDay.events.map((event) => event.occurrenceStart),
    ).toEqual(["2026-10-31"]);
    expect(of("unsupported")).toHaveLength(1);
    expect(result.counts).toMatchObject({
      series: 5,
      unsupportedRecurrence: 1,
      cancelled: 1,
    });
  });

  it("bounds output, tolerates unknown zones and rejects non-calendar input", () => {
    const truncated = parseIcalFeed(
      calendar(
        "UID:forever\nSUMMARY:Every day\nDTSTART:20260901T100000Z\nDTEND:20260901T103000Z\nRRULE:FREQ=DAILY",
      ),
      { ...window, maxPerSeries: 5 },
    );
    expect(truncated.ok && truncated.events.length).toBe(5);
    expect(truncated.ok && truncated.counts.truncated).toBe(1);
    const total = parseIcalFeed(
      calendar(
        ...Array.from(
          { length: 4 },
          (_, index) =>
            `UID:e${String(index)}\nSUMMARY:E\nDTSTART:2026090${String(index + 1)}T100000Z\nDTEND:2026090${String(index + 1)}T110000Z`,
        ),
      ),
      { ...window, maxOccurrences: 2 },
    );
    expect(total.ok && total.events.length).toBe(2);
    expect(total.ok && total.counts.truncated).toBe(2);
    const zones = parseIcalFeed(
      calendar(
        "UID:win\nSUMMARY:Windows zone\nDTSTART;TZID=Central Standard Time:20260910T090000\nDTEND;TZID=Central Standard Time:20260910T100000",
        "UID:bad\nSUMMARY:No start",
        "UID:baddate\nSUMMARY:Bad date\nDTSTART:20260231T090000Z",
      ),
      window,
    );
    expect(zones.ok && zones.events).toHaveLength(1);
    expect(zones.ok && zones.events[0]?.startsAt).toBe(
      "2026-09-10T14:00:00.000Z",
    );
    expect(zones.ok && zones.counts).toMatchObject({
      unknownTimeZones: 2,
      invalid: 2,
    });
    expect(parseIcalFeed("<html>not a calendar</html>", window)).toEqual({
      ok: false,
      reason: "not_calendar",
    });
    expect(parseIcalFeed("BEGIN:VCALENDAR\0", window)).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(parseIcalFeed("x".repeat(4 * 1024 * 1024 + 1), window)).toEqual({
      ok: false,
      reason: "too_large",
    });
  });
});
