import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GooglePlanning } from "./google-planning.tsx";

const preferences = {
  workingDays: [1, 2, 3, 4, 5],
  workdayStart: "09:00",
  workdayEnd: "17:00",
  breakStart: "12:00",
  breakEnd: "12:30",
  timeZone: "UTC" as const,
};

const dayPlan = {
  at: "2026-08-07T10:00:00.000Z",
  state: "working" as const,
  preferences,
  orderedTasks: [],
  nextTask: null,
  reminder: { suppressed: true, reason: "no_scheduled_task" as const },
  freshness: {
    state: "fresh" as const,
    projectedAt: "2026-08-07T09:59:00.000Z",
    message: "Calendar projection is current",
  },
};

const callbacks = {
  onAuthorize: vi.fn(() => Promise.resolve("https://accounts.google.com/")),
  onSynchronize: vi.fn(() => Promise.resolve()),
  onDisconnect: vi.fn(() => Promise.resolve()),
  onSavePreferences: vi.fn(() => Promise.resolve()),
};

describe("Google planning surface", () => {
  it("keeps the rest of the Suite usable when credentials are not configured", () => {
    const html = renderToStaticMarkup(
      <GooglePlanning
        status={{
          configured: false,
          connected: false,
          state: "disconnected",
          providerId: null,
          accountLabel: null,
          grantedScopes: [],
          calendars: [],
          freshness: [],
        }}
        preferences={preferences}
        dayPlan={dayPlan}
        busy={false}
        {...callbacks}
      />,
    );
    expect(html).toContain("Google OAuth credentials are not installed yet");
    expect(html).toContain("Baïkal and local tasks continue to work normally");
    expect(html).toContain("Working hours and quiet break");
  });

  it("shows per-calendar freshness, calm status, sync, and disconnect controls", () => {
    const html = renderToStaticMarkup(
      <GooglePlanning
        status={{
          configured: true,
          connected: true,
          state: "connected",
          providerId: "00000000-0000-4000-8000-000000000031",
          accountLabel: "owner@example.test",
          grantedScopes: ["calendar.events.readonly"],
          calendars: [
            {
              id: "00000000-0000-4000-8000-000000000032",
              providerId: "00000000-0000-4000-8000-000000000031",
              href: "owner@example.test",
              displayName: "Primary",
              supportsEvents: true,
              supportsTodos: false,
            },
          ],
          freshness: [
            {
              calendarId: "00000000-0000-4000-8000-000000000032",
              state: "fresh",
              lastSuccessfulSyncAt: "2026-08-07T09:59:00.000Z",
              message: "Google projection is current",
            },
          ],
        }}
        preferences={preferences}
        dayPlan={dayPlan}
        busy={false}
        {...callbacks}
      />,
    );
    expect(html).toContain("owner@example.test");
    expect(html).toContain("Primary");
    expect(html).toContain("Google projection is current");
    expect(html).toContain("Sync Google now");
    expect(html).toContain("Resync Google Calendar");
    expect(html).toContain("existing Google connection");
    expect(html).toContain("Disconnect Google");
    expect(html).toContain("Reminder: quiet");
  });
});
