import { expect, it } from "vitest";
import {
  calDavEventIcs,
  envelopeDigest,
  googleEventBody,
  googleInstanceBody,
  googleInstanceId,
  normalizeCalDavEvent,
  normalizeGoogleEvent,
  normalizeGoogleSeries,
  parseEnvelope,
} from "./envelope.ts";

// Normalized envelope v2 (ADR 0041, ADR 0042).
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
const now = "2026-09-25T00:00:00.000Z";

const ics = (...lines: string[]) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR", ""].join(
    "\r\n",
  );

it("keeps the IANA zone and wall time and round-trips through both providers", () => {
  const fromGoogle = normalizeGoogleEvent(google);
  expect(fromGoogle.unsupportedFields).toEqual([]);
  expect(fromGoogle.envelope).toMatchObject({
    start: "2026-10-01T10:00:00",
    end: "2026-10-01T11:00:00",
    startZone: "America/Chicago",
    endZone: "America/Chicago",
    location: null,
  });
  const body = calDavEventIcs(fromGoogle.envelope, "abc@google.com", now);
  expect(body).toContain("DTSTART;TZID=America/Chicago:20261001T100000");
  const fromIcs = normalizeCalDavEvent(body);
  expect(fromIcs.uid).toBe("abc@google.com");
  expect(fromIcs.envelope).toEqual(fromGoogle.envelope);
  expect(fromIcs.digest).toBe(fromGoogle.digest);
  const written = googleEventBody(fromIcs.envelope);
  expect(written.start).toEqual({
    dateTime: "2026-10-01T10:00:00",
    timeZone: "America/Chicago",
  });
  expect(
    normalizeGoogleEvent({ id: "x", etag: '"2"', ...written }).digest,
  ).toBe(fromGoogle.digest);
});

it("hashes envelopes without version 2 content exactly as version 1", () => {
  // Digests recorded from the ADR 0041 implementation.
  const utc = normalizeGoogleEvent({
    id: "u",
    etag: '"1"',
    summary: "Dentist",
    location: "Room 4",
    start: { dateTime: "2026-10-01T15:00:00Z", timeZone: "UTC" },
    end: { dateTime: "2026-10-01T16:00:00Z", timeZone: "UTC" },
  });
  expect(utc.envelope.startZone).toBeNull();
  expect(utc.digest).toBe("TBhne-DTgywbahtgKZiUjelGLkH7M-iCV3vrd3e_7sM");
  const v1 = JSON.stringify({
    v: 1,
    summary: "Dentist",
    description: null,
    location: "Room 4",
    allDay: true,
    start: "2026-10-02",
    end: "2026-10-03",
    unsupported: { colorId: '"3"' },
  });
  const parsed = parseEnvelope(v1);
  expect(parsed).toMatchObject({ v: 2, recurrence: null, invitation: null });
  expect(envelopeDigest(parsed ?? utc.envelope)).toBe(
    "J_ZAfPO4IWyGOAwIIIqtbRIJC3B8M4cR9eqSZYUzyX8",
  );
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
  const body = calDavEventIcs(allDay.envelope, "d", now);
  expect(body).toContain("DTSTART;VALUE=DATE:20261002");
  expect(normalizeCalDavEvent(body).digest).toBe(allDay.digest);
  // An all-day VEVENT without DTEND lasts one day.
  expect(
    normalizeCalDavEvent(
      ics(
        "BEGIN:VEVENT",
        "UID:d",
        "DTSTART;VALUE=DATE:20261002",
        "SUMMARY:",
        "END:VEVENT",
      ),
    ).digest,
  ).toBe(allDay.digest);
  expect(
    normalizeGoogleEvent({ ...google, summary: undefined }).digest,
  ).not.toBe(normalizeGoogleEvent({ ...google, summary: "" }).digest);
});

// A weekly Thursday series across the US DST change on 2026-11-01.
const chicago = (date: string, hour: number, offset: string) => ({
  dateTime: `${date}T${String(hour)}:00:00${offset}`,
  timeZone: "America/Chicago",
});
const master = {
  ...google,
  id: "series",
  iCalUID: "series@google.com",
  summary: "Standup",
  start: chicago("2026-10-22", 10, "-05:00"),
  end: chicago("2026-10-22", 11, "-05:00"),
  recurrence: [
    "RRULE:BYDAY=TH;FREQ=WEEKLY",
    "EXDATE;TZID=America/Chicago:20261029T100000",
  ],
};
const moved = {
  id: "series_20261105T160000Z",
  etag: '"3"',
  status: "confirmed",
  iCalUID: "series@google.com",
  recurringEventId: "series",
  originalStartTime: chicago("2026-11-05", 10, "-06:00"),
  summary: "Standup (moved)",
  start: chicago("2026-11-05", 14, "-06:00"),
  end: chicago("2026-11-05", 15, "-06:00"),
  organizer: { email: "me@example.test", self: true },
};
const cancelled = {
  id: "series_20261112T160000Z",
  etag: '"4"',
  status: "cancelled",
  recurringEventId: "series",
  originalStartTime: chicago("2026-11-12", 10, "-06:00"),
};

it("carries a series with moved and cancelled instances keyed by wall time", () => {
  const series = normalizeGoogleSeries(master, [moved, cancelled]);
  expect(series.unsupportedFields).toEqual([]);
  expect(series.envelope.recurrence).toEqual({
    rules: ["FREQ=WEEKLY;BYDAY=TH"],
    rdates: [],
    exdates: ["2026-10-29T10:00:00", "2026-11-12T10:00:00"],
    overrides: {
      "2026-11-05T10:00:00": {
        summary: "Standup (moved)",
        description: null,
        location: null,
        allDay: false,
        start: "2026-11-05T14:00:00",
        end: "2026-11-05T15:00:00",
        startZone: "America/Chicago",
        endZone: "America/Chicago",
      },
    },
  });
  const body = calDavEventIcs(series.envelope, "series@google.com", now);
  expect(body).toContain("RRULE:FREQ=WEEKLY;BYDAY=TH");
  expect(body).toContain(
    "EXDATE;TZID=America/Chicago:20261029T100000,20261112T100000",
  );
  expect(body).toContain("RECURRENCE-ID;TZID=America/Chicago:20261105T100000");
  expect(body).not.toMatch(/ORGANIZER|ATTENDEE/);
  expect(normalizeCalDavEvent(body).digest).toBe(series.digest);

  // Google instance IDs use the UTC start, which moves by an hour at DST.
  expect(
    googleInstanceId("series", series.envelope, "2026-10-29T10:00:00"),
  ).toBe("series_20261029T150000Z");
  expect(
    googleInstanceId("series", series.envelope, "2026-11-05T10:00:00"),
  ).toBe("series_20261105T160000Z");
  // Writing the master and the instance back to Google reproduces the digest.
  const instance = googleInstanceBody(
    "series",
    series.envelope,
    "2026-11-05T10:00:00",
  );
  expect(instance).toMatchObject({
    recurringEventId: "series",
    originalStartTime: {
      dateTime: "2026-11-05T10:00:00",
      timeZone: "America/Chicago",
    },
    start: { dateTime: "2026-11-05T14:00:00" },
  });
  expect(
    normalizeGoogleSeries(
      {
        id: "series",
        etag: '"9"',
        iCalUID: "copy",
        ...googleEventBody(series.envelope),
      },
      [{ id: "i", etag: '"a"', ...instance }],
    ).digest,
  ).toBe(series.digest);
});

it("normalizes equivalent iCalendar forms of cancelled and unchanged instances", () => {
  const vevent = (...lines: string[]) => [
    "BEGIN:VEVENT",
    "UID:local",
    ...lines,
    "END:VEVENT",
  ];
  const head = [
    "DTSTART;TZID=America/Chicago:20261022T100000",
    "DTEND;TZID=America/Chicago:20261022T110000",
    "SUMMARY:Standup",
  ];
  const withExdate = normalizeCalDavEvent(
    ics(...vevent(...head, "RRULE:FREQ=WEEKLY", "EXDATE:20261112T160000Z")),
  );
  expect(withExdate.envelope.recurrence?.exdates).toEqual([
    "2026-11-12T10:00:00",
  ]);
  // A cancelled override and an unchanged one mean the same series.
  const withOverrides = normalizeCalDavEvent(
    ics(
      ...vevent(...head, "RRULE:FREQ=WEEKLY"),
      ...vevent(
        "RECURRENCE-ID;TZID=America/Chicago:20261112T100000",
        "DTSTART;TZID=America/Chicago:20261112T100000",
        "DTEND;TZID=America/Chicago:20261112T110000",
        "STATUS:CANCELLED",
      ),
      ...vevent(
        "RECURRENCE-ID;TZID=America/Chicago:20261119T100000",
        "DTSTART;TZID=America/Chicago:20261119T100000",
        "DTEND;TZID=America/Chicago:20261119T110000",
        "SUMMARY:Standup",
      ),
    ),
  );
  expect(withOverrides.unsupportedFields).toEqual([]);
  expect(withOverrides.digest).toBe(withExdate.digest);

  const allDay = normalizeCalDavEvent(
    ics(
      ...vevent(
        "DTSTART;VALUE=DATE:20261231",
        "DTEND;VALUE=DATE:20270101",
        "RRULE:FREQ=YEARLY",
        "EXDATE;VALUE=DATE:20271231",
      ),
    ),
  );
  expect(allDay.envelope).toMatchObject({
    allDay: true,
    start: "2026-12-31",
    recurrence: { exdates: ["2027-12-31"] },
  });
  expect(calDavEventIcs(allDay.envelope, "local", now)).toContain(
    "EXDATE;VALUE=DATE:20271231",
  );
});

it("lists unsupported content and changes the digest when it changes", () => {
  expect(
    normalizeGoogleEvent({ ...google, recurrence: ["EXRULE:FREQ=DAILY"] })
      .unsupportedFields,
  ).toEqual(["recurrence"]);
  const invited = normalizeGoogleEvent({
    ...google,
    attendees: [{ email: "a@example.test" }],
  });
  expect(invited).toMatchObject({
    unsupportedFields: [],
    invitationEffect: true,
  });
  // The bridge digest ignores invitation data; the snapshot keeps it.
  expect(invited.digest).toBe(normalizeGoogleEvent(google).digest);
  expect(invited.envelope.invitation?.[""]).toContain("a@example.test");
  expect(
    normalizeGoogleEvent({
      ...google,
      organizer: { email: "boss@example.test" },
    }).invitationEffect,
  ).toBe(true);
  expect(normalizeGoogleEvent({ ...google, colorId: "3" }).digest).not.toBe(
    normalizeGoogleEvent({ ...google, colorId: "4" }).digest,
  );
  expect(
    normalizeGoogleEvent({
      ...google,
      start: { dateTime: "2026-10-01T10:00:00Z", timeZone: "Mars/Olympus" },
    }).unsupportedFields,
  ).toEqual(["timezone"]);

  const event = (...extra: string[]) =>
    normalizeCalDavEvent(
      ics(
        "BEGIN:VEVENT",
        "UID:u",
        "DTSTART;TZID=Europe/Berlin:20261001T100000",
        "DTEND;TZID=Europe/Berlin:20261001T110000",
        ...extra,
        "END:VEVENT",
      ),
    );
  expect(event("ATTENDEE:mailto:a@example.test")).toMatchObject({
    unsupportedFields: [],
    invitationEffect: true,
  });
  expect(event("X-VENDOR:1").unsupportedFields).toEqual(["X-VENDOR"]);
  expect(event("DURATION:PT1H").unsupportedFields).toEqual(["DURATION"]);
  expect(
    event(
      "RRULE:FREQ=DAILY",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:u",
      "RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Berlin:20261003T100000",
      "DTSTART;TZID=Europe/Berlin:20261003T120000",
      "DTEND;TZID=Europe/Berlin:20261003T130000",
    ).unsupportedFields,
  ).toEqual(["recurrence"]);
  const timed = (start: string) =>
    normalizeCalDavEvent(
      ics(
        "BEGIN:VEVENT",
        "UID:f",
        `DTSTART${start}`,
        `DTEND${start}`,
        "END:VEVENT",
      ),
    ).unsupportedFields;
  expect(timed(":20261001T100000")).toEqual(["timezone"]);
  expect(timed(";TZID=Eastern Standard Time:20261001T100000")).toEqual([
    "timezone",
  ]);
  expect(
    normalizeCalDavEvent(
      ics(
        "BEGIN:VEVENT",
        "UID:a",
        "DTSTART:20261001T100000Z",
        "DTEND:20261001T110000Z",
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "END:VALARM",
        "END:VEVENT",
      ),
    ).unsupportedFields,
  ).toEqual(["alarms"]);
});
