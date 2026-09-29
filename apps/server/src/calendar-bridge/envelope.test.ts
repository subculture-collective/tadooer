import { expect, it } from "vitest";
import {
  calDavEventIcs,
  googleEventBody,
  normalizeCalDavEvent,
  normalizeGoogleEvent,
} from "./envelope.ts";

// Normalized envelope v1 (ADR 0041).
const google = {
  kind: "calendar#event",
  id: "abc",
  etag: '"1"',
  status: "confirmed",
  iCalUID: "abc@google.com",
  summary: "Review; notes, draft\\final",
  description: "Line one\nLine two",
  start: { dateTime: "2026-10-01T10:00:00-05:00", timeZone: "America/Chicago" },
  end: { dateTime: "2026-10-01T11:00:00-05:00", timeZone: "America/Chicago" },
  organizer: { email: "me@example.test", self: true },
  reminders: { useDefault: true },
};

it("gives the same digest to the same event from either provider", () => {
  const fromGoogle = normalizeGoogleEvent(google);
  expect(fromGoogle.unsupportedFields).toEqual([]);
  expect(fromGoogle.envelope).toMatchObject({
    start: "2026-10-01T15:00:00.000Z",
    location: null,
  });
  const ics = calDavEventIcs(
    fromGoogle.envelope,
    "abc@google.com",
    "2026-09-25T00:00:00.000Z",
  );
  const fromIcs = normalizeCalDavEvent(ics);
  expect(fromIcs.uid).toBe("abc@google.com");
  expect(fromIcs.envelope).toEqual(fromGoogle.envelope);
  expect(fromIcs.digest).toBe(fromGoogle.digest);
  // And back to Google without loss.
  expect(
    normalizeGoogleEvent({
      id: "x",
      etag: '"2"',
      ...googleEventBody(fromIcs.envelope),
    }).digest,
  ).toBe(fromGoogle.digest);
});

it("keeps all-day dates as dates and distinguishes empty from absent", () => {
  const allDay = normalizeGoogleEvent({
    id: "d",
    etag: '"1"',
    summary: "",
    start: { date: "2026-10-02" },
    end: { date: "2026-10-03" },
  });
  expect(allDay.envelope).toMatchObject({
    allDay: true,
    start: "2026-10-02",
    summary: "",
    description: null,
  });
  const ics = calDavEventIcs(allDay.envelope, "d", "2026-09-25T00:00:00.000Z");
  expect(ics).toContain("DTSTART;VALUE=DATE:20261002");
  expect(normalizeCalDavEvent(ics).digest).toBe(allDay.digest);
  expect(
    normalizeGoogleEvent({ ...google, summary: undefined }).digest,
  ).not.toBe(normalizeGoogleEvent({ ...google, summary: "" }).digest);
});

it("lists unsupported content and changes the digest when it changes", () => {
  const weekly = normalizeGoogleEvent({
    ...google,
    recurrence: ["RRULE:FREQ=WEEKLY"],
  });
  expect(weekly.unsupportedFields).toEqual(["recurrence"]);
  const invited = normalizeGoogleEvent({
    ...google,
    attendees: [{ email: "a@example.test" }],
  });
  expect(invited).toMatchObject({
    unsupportedFields: ["attendees"],
    invitationEffect: true,
  });
  expect(normalizeGoogleEvent({ ...google, colorId: "3" }).digest).not.toBe(
    normalizeGoogleEvent({ ...google, colorId: "4" }).digest,
  );

  const ics = (extra: string) =>
    normalizeCalDavEvent(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:u",
        "DTSTART;TZID=Europe/Berlin:20261001T100000",
        "DTEND;TZID=Europe/Berlin:20261001T110000",
        extra,
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
  expect(ics("ATTENDEE:mailto:a@example.test")).toMatchObject({
    unsupportedFields: ["ATTENDEE", "timezone"],
    invitationEffect: true,
  });
  expect(ics("X-VENDOR:1").unsupportedFields).toEqual(["X-VENDOR", "timezone"]);
  expect(
    normalizeCalDavEvent(
      "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261001T100000Z\r\nDTEND:20261001T110000Z\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
    ).unsupportedFields,
  ).toEqual(["alarms"]);
});
