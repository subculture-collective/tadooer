import { describe, expect, it } from "vitest";
import { parseIcsImport, serializeCalendarFeed } from "./index.ts";

const source = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:google-recurring-1",
  "DTSTART:20260807T120000Z",
  "DTEND:20260807T130000Z",
  "SUMMARY:Practice",
  "RRULE:FREQ=WEEKLY;COUNT=4",
  "ATTENDEE:mailto:friend@example.test",
  "X-GOOGLE-CONFERENCE:https://example.test/secret-safe-fixture",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "TRIGGER:-PT10M",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "DTSTART:20260808T120000Z",
  "DTEND:20260808T130000Z",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

describe("import/export intermediate representation", () => {
  it("preserves complex Google ICS and reports every compatibility boundary", () => {
    const report = parseIcsImport("google_ics", source);
    expect(report.totals).toMatchObject({
      components: 2,
      ready: 1,
      skipped: 1,
      recurring: 1,
      attendees: 1,
      alarms: 1,
    });
    expect(report.skipped).toContainEqual(
      expect.objectContaining({ code: "missing_uid" }),
    );
    expect(report.candidates[0]?.rawIcs).toContain("RRULE:FREQ=WEEKLY");
    expect(report.candidates[0]?.rawIcs).toContain("BEGIN:VALARM");
    expect(report.candidates[0]?.unknownProperties).toContain(
      "X-GOOGLE-CONFERENCE",
    );
    expect(report.candidates[0]?.issues).toContainEqual(
      expect.objectContaining({ code: "unknown_properties_preserved" }),
    );
  });

  it("exports preserved VEVENT bodies in one explicitly read-only calendar", () => {
    const candidate = parseIcsImport("ics", source).candidates[0];
    if (candidate === undefined) throw new Error("Fixture candidate missing");
    const feed = serializeCalendarFeed([candidate.rawIcs]);
    expect(feed.match(/BEGIN:VCALENDAR/g)).toHaveLength(1);
    expect(feed.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(feed).toContain("X-WR-CALNAME:Suite read-only feed");
  });
});
