import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CalendarMigration,
  calendarFileValidationError,
} from "./calendar-migration.tsx";

describe("Calendar migration file interaction", () => {
  it("renders a bounded ICS file picker instead of a raw-content text box", () => {
    const html = renderToStaticMarkup(
      <CalendarMigration
        csrfToken="csrf-token"
        calendars={[
          {
            id: "00000000-0000-4000-8000-000000000071",
            providerId: "00000000-0000-4000-8000-000000000072",
            href: "/calendars/owner/work/",
            displayName: "Work",
            supportsEvents: true,
            supportsTodos: false,
          },
        ]}
      />,
    );

    expect(html).toContain('type="file"');
    expect(html).toContain('accept=".ics,text/calendar"');
    expect(html).toContain("Choose one `.ics` export, up to 4 MiB");
    expect(html).not.toContain("<textarea");
    expect(html).toContain("Preview import");
  });

  it("rejects wrong, empty, and oversized files before upload", () => {
    expect(
      calendarFileValidationError({ name: "calendar.txt", size: 100 }),
    ).toContain("ends in .ics");
    expect(
      calendarFileValidationError({ name: "calendar.ics", size: 0 }),
    ).toContain("empty");
    expect(
      calendarFileValidationError({
        name: "calendar.ics",
        size: 4 * 1024 * 1024 + 1,
      }),
    ).toContain("4 MiB");
    expect(
      calendarFileValidationError({ name: "CALENDAR.ICS", size: 4096 }),
    ).toBeNull();
  });
});
