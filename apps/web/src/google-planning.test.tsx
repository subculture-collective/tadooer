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
          write: { consent: "none", consentedAt: null, scopeGranted: false },
          capabilities: [],
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
          write: { consent: "none", consentedAt: null, scopeGranted: false },
          capabilities: [],
        }}
        preferences={preferences}
        dayPlan={dayPlan}
        busy={false}
        {...callbacks}
      />,
    );
    expect(html).toContain("owner@example.test");
    expect(html).toContain("Primary");
    expect(html).toContain("Last successful sync:");
    expect(html).toContain("2026-08-07T09:59:00.000Z");
    expect(html).toContain("Google refresh is currently manual");
    expect(html).toContain("Google projection is current");
    expect(html).toContain("Sync Google now");
    expect(html).toContain("Resync Google Calendar");
    expect(html).toContain("existing Google connection");
    expect(html).toContain("Disconnect Google");
    expect(html).toContain("Reminder: quiet");
  });
  it("keeps write consent separate and shows per-calendar writable state", () => {
    const calendar = (id: string, displayName: string) => ({
      id,
      providerId: "00000000-0000-4000-8000-000000000031",
      href: `${displayName}@example.test`,
      displayName,
      supportsEvents: true,
      supportsTodos: false,
    });
    const owned = "00000000-0000-4000-8000-000000000041";
    const shared = "00000000-0000-4000-8000-000000000042";
    const base = {
      configured: true,
      connected: true,
      state: "connected" as const,
      providerId: "00000000-0000-4000-8000-000000000031",
      accountLabel: "owner@example.test",
      grantedScopes: [],
      calendars: [calendar(owned, "Owned"), calendar(shared, "Shared")],
      freshness: [],
    };
    const render = (status: Parameters<typeof GooglePlanning>[0]["status"]) =>
      renderToStaticMarkup(
        <GooglePlanning
          mode="connection"
          status={status}
          preferences={preferences}
          dayPlan={dayPlan}
          busy={false}
          {...callbacks}
          onAuthorizeWrite={vi.fn(() =>
            Promise.resolve("https://accounts.google.com/"),
          )}
          onWithdrawWrite={vi.fn(() => Promise.resolve())}
        />,
      );

    const readOnly = render({
      ...base,
      write: { consent: "none", consentedAt: null, scopeGranted: false },
      capabilities: [
        {
          calendarId: owned,
          accessRole: "owner",
          writable: false,
          reason: "consent-required",
        },
        {
          calendarId: shared,
          accessRole: "reader",
          writable: false,
          reason: "consent-required",
        },
      ],
    });
    expect(readOnly).toContain("Tadooer has read-only access");
    expect(readOnly).toContain("Allow event changes");
    expect(readOnly).not.toContain("Withdraw event changes");
    expect(readOnly).toContain("Read only (event changes not allowed)");
    expect(readOnly).not.toContain('data-writable="true"');

    const granted = render({
      ...base,
      write: {
        consent: "granted",
        consentedAt: "2026-09-29T12:00:00.000Z",
        scopeGranted: true,
      },
      capabilities: [
        {
          calendarId: owned,
          accessRole: "owner",
          writable: true,
          reason: null,
        },
        {
          calendarId: shared,
          accessRole: "reader",
          writable: false,
          reason: "read-only-calendar",
        },
      ],
    });
    expect(granted).toContain("Event changes allowed");
    expect(granted).toContain("Withdraw event changes");
    expect(granted).not.toContain("Allow event changes again");
    expect(granted).toContain('data-writable="true"');
    expect(granted).toContain("Read only (read only in Google)");
    expect(granted).toContain("Google keeps the");

    const lost = render({
      ...base,
      write: {
        consent: "lost",
        consentedAt: "2026-09-29T12:00:00.000Z",
        scopeGranted: false,
      },
      capabilities: [
        {
          calendarId: owned,
          accessRole: "owner",
          writable: false,
          reason: "scope-missing",
        },
      ],
    });
    expect(lost).toContain("Google no longer allows event changes");
    expect(lost).toContain('role="alert"');
    expect(lost).toContain("Allow event changes again");
    expect(lost).toContain("Withdraw event changes");
    expect(lost).not.toContain('data-writable="true"');
  });

  it("does not offer write consent where no write handlers are supplied", () => {
    const html = renderToStaticMarkup(
      <GooglePlanning
        status={{
          configured: true,
          connected: true,
          state: "connected",
          providerId: null,
          accountLabel: null,
          grantedScopes: [],
          calendars: [],
          freshness: [],
          write: { consent: "none", consentedAt: null, scopeGranted: false },
          capabilities: [],
        }}
        preferences={preferences}
        dayPlan={dayPlan}
        busy={false}
        {...callbacks}
      />,
    );
    expect(html).not.toContain("Allow event changes");
  });
});
