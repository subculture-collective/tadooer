import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./app.tsx";

describe("App", () => {
  it("renders the one-owner setup contract", () => {
    const markup = renderToStaticMarkup(
      <App initialState={{ kind: "setup" }} />,
    );
    expect(markup).toContain("Create the owner account");
    expect(markup).toContain("at least 14 characters");
    expect(markup).toContain("one owner");
  });

  it("renders discovered event and todo capabilities without claiming event reads", () => {
    const markup = renderToStaticMarkup(
      <App
        initialState={{
          kind: "authenticated",
          session: {
            owner: {
              id: "d1054acd-c04d-4bd8-a814-254b007154ba",
              username: "owner",
              displayName: "Owner",
            },
            csrfToken: "A".repeat(43),
            expiresAt: "2026-08-05T12:00:00.000Z",
          },
          baikal: {
            connected: true,
            providerId: "728a504a-0997-4eb3-94dd-5d6ff8af5967",
            endpoint: "http://baikal/dav.php/",
            username: "alice",
            verifiedAt: "2026-08-05T00:00:00.000Z",
            calendars: [
              {
                id: "4519c805-e478-486b-a918-616fc6d9ea98",
                providerId: "728a504a-0997-4eb3-94dd-5d6ff8af5967",
                href: "/dav.php/calendars/alice/work/",
                displayName: "Work",
                supportsEvents: true,
                supportsTodos: true,
              },
            ],
          },
          tasks: [
            {
              id: "afcab502-2199-43fd-b9d3-c8b556c6f25b",
              title: "Capture the first task",
              notes: "Retry-safe and owner-scoped",
              status: "open",
              revision: 1,
              createdAt: "2026-08-05T12:00:00.000Z",
              updatedAt: "2026-08-05T12:00:00.000Z",
              completedAt: null,
              deletedAt: null,
              plannedStart: "2026-08-06T14:00:00.000Z",
              estimateMinutes: 45,
            },
          ],
          recovery: [],
          planner: {
            window: {
              from: "2026-08-06T00:00:00.000Z",
              to: "2026-08-13T00:00:00.000Z",
            },
            tasks: [],
            events: [
              {
                identity: {
                  providerId: "728a504a-0997-4eb3-94dd-5d6ff8af5967",
                  calendarId: "4519c805-e478-486b-a918-616fc6d9ea98",
                  eventId: "/dav.php/calendars/alice/work/event.ics",
                },
                href: "/dav.php/calendars/alice/work/event.ics",
                uid: "event-1",
                etag: '"event-v1"',
                summary: "Existing appointment",
                startsAt: "2026-08-06T12:00:00.000Z",
                endsAt: "2026-08-06T13:00:00.000Z",
                allDay: false,
                recurrence: "none",
                projectedAt: "2026-08-06T00:01:00.000Z",
              },
            ],
            freshness: {
              state: "fresh",
              projectedAt: "2026-08-06T00:01:00.000Z",
              message: "Calendar projection is current",
            },
          },
        }}
      />,
    );
    expect(markup).toContain("Planner connected");
    expect(markup).toContain("Events · Todos");
    expect(markup).toContain(
      "Recurrence editing, offline writes, Google, and broad calendar mutation remain later-phase capabilities",
    );
    expect(markup).toContain("Capture a task");
    expect(markup).toContain("Capture the first task");
    expect(markup).toContain("Revision 1");
    expect(markup).toContain("Existing appointment");
    expect(markup).toContain("Move calendar block");
    expect(markup).toContain("Recently deleted tasks (0)");
    expect(markup).toContain("Local-first focus · Phase 2");
    expect(markup).toContain("Focus session");
    expect(markup).toContain("Estimate minutes");
    expect(markup).toContain("Projects and tags");
    expect(markup).toContain("Sync now");
    expect(markup).toContain("Migration &amp; read-only publication");
    expect(markup).toContain("Google Calendar ICS/Takeout");
    expect(markup).toContain("Create revocable read-only feed");
    expect(markup).toContain(
      "/api/calendars/4519c805-e478-486b-a918-616fc6d9ea98/export.ics",
    );
  });

  it("renders a bounded offline task workspace without calendar or focus controls", () => {
    const markup = renderToStaticMarkup(
      <App
        initialState={{
          kind: "offline",
          tasks: [
            {
              id: "afcab502-2199-43fd-b9d3-c8b556c6f25b",
              title: "Durable offline task",
              notes: "Queued in IndexedDB",
              status: "open",
              revision: 1,
              createdAt: "2026-08-06T12:00:00.000Z",
              updatedAt: "2026-08-06T12:00:00.000Z",
              deletedAt: null,
            },
          ],
          recovery: [],
          conflictCount: 1,
          message: "Working from this browser’s durable task cache.",
        }}
      />,
    );
    expect(markup).toContain("Keep working locally");
    expect(markup).toContain("Durable offline task");
    expect(markup).toContain("Save locally");
    expect(markup).toContain("Visible sync conflicts: 1");
    expect(markup).toContain("Sync now");
    expect(markup).toContain("Export redacted sync diagnostics");
    expect(markup).not.toContain("Place in calendar");
    expect(markup).not.toContain("Start focus");
  });
});
