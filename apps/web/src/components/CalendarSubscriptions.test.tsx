import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  CalendarSubscription,
  CalendarSubscriptionEvent,
} from "@suite/contracts";
import { CalendarSubscriptionsView } from "./CalendarSubscriptions.tsx";
import {
  createInputFromForm,
  describeFetch,
  upcomingWindow,
} from "./calendar-subscription-controller.ts";

// Calendar subscriptions view (issue #91, ADR 0032).
const at = "2026-09-25T15:00:00.000Z";
const subscription: CalendarSubscription = {
  id: "00000000-0000-4000-8000-000000000001",
  ownerId: "00000000-0000-4000-8000-000000000009",
  revision: 3,
  name: "Team calendar",
  urlHost: "calendar.example.test",
  refreshIntervalMinutes: 60,
  color: null,
  icon: null,
  includePattern: null,
  excludePattern: null,
  referenceOnly: false,
  autoImport: true,
  enabled: true,
  hidden: false,
  freshness: { state: "fresh", message: "Feed fetched recently" },
  lastAttemptAt: at,
  lastSuccessAt: at,
  lastErrorClass: null,
  nextFetchAt: "2026-09-25T16:00:00.000Z",
  eventCount: 2,
  createdAt: at,
  updatedAt: at,
};
const paused: CalendarSubscription = {
  ...subscription,
  id: "00000000-0000-4000-8000-000000000002",
  name: "Holidays",
  urlHost: "holidays.example.test",
  enabled: false,
  referenceOnly: true,
  autoImport: false,
  freshness: {
    state: "unavailable",
    message: "No successful fetch yet (http_404)",
  },
  eventCount: 0,
};
const events: CalendarSubscriptionEvent[] = [
  {
    subscriptionId: subscription.id,
    subscriptionName: "Team calendar",
    referenceOnly: false,
    uid: "standup",
    occurrenceStart: "2026-09-25T16:00:00.000Z",
    summary: "Standup",
    startsAt: "2026-09-25T16:00:00.000Z",
    endsAt: "2026-09-25T16:30:00.000Z",
    allDay: false,
    recurring: true,
    url: "https://calendar.example.test/e/standup",
    hidden: false,
    taskId: null,
    tombstoned: false,
  },
  {
    subscriptionId: subscription.id,
    subscriptionName: "Team calendar",
    referenceOnly: false,
    uid: "review",
    occurrenceStart: "2026-09-26",
    summary: "Review day",
    startsAt: "2026-09-26T00:00:00.000Z",
    endsAt: "2026-09-27T00:00:00.000Z",
    allDay: true,
    recurring: false,
    url: null,
    hidden: true,
    taskId: "00000000-0000-4000-8000-000000000042",
    tombstoned: true,
  },
];

const view = (
  props: Partial<Parameters<typeof CalendarSubscriptionsView>[0]> = {},
) =>
  renderToStaticMarkup(
    <CalendarSubscriptionsView
      subscriptions={[subscription, paused]}
      events={events}
      pendingDelete={null}
      busy={false}
      message={null}
      error={null}
      onCreate={vi.fn()}
      onRefresh={vi.fn()}
      onToggle={vi.fn()}
      onRequestDelete={vi.fn()}
      onConfirmDelete={vi.fn()}
      onCancelDelete={vi.fn()}
      onHideEvent={vi.fn()}
      onConvertEvent={vi.fn()}
      {...props}
    />,
  );

describe("calendar subscriptions", () => {
  it("shows hosts, freshness and event actions without any address", () => {
    const markup = view();
    for (const text of [
      "Calendar subscriptions",
      "Team calendar",
      "calendar.example.test",
      "fresh",
      "Auto-import",
      "2 saved events",
      "Holidays",
      "unavailable",
      "No successful fetch yet (http_404)",
      "Paused",
      "Reference",
      "Refresh now",
      "Next 7 days",
      "Standup",
      "Add task",
      "Review day",
      "Task created",
      "Hidden",
      "Online only",
    ])
      expect(markup).toContain(text);
    expect(markup).not.toContain("alertdialog");
    expect(view({ subscriptions: [], events: [] })).toContain(
      "No calendar subscriptions yet.",
    );
    expect(view({ subscriptions: [subscription], events: [] })).toContain(
      "No subscribed events in the next 7 days.",
    );
  });

  it("asks before removing a subscription", () => {
    const markup = view({ pendingDelete: subscription });
    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain("Remove subscription");
    expect(markup).toContain("tasks already created stay");
  });

  it("validates the form and describes fetch outcomes without addresses", () => {
    const base = {
      name: " Team ",
      url: " webcal://calendar.example.test/x.ics ",
      refreshIntervalMinutes: "60",
      includePattern: "",
      excludePattern: " lunch ",
      referenceOnly: true,
      autoImport: true,
    };
    expect(createInputFromForm(base)).toEqual({
      name: "Team",
      url: "webcal://calendar.example.test/x.ics",
      refreshIntervalMinutes: 60,
      includePattern: null,
      excludePattern: "lunch",
      referenceOnly: true,
      // A reference calendar never auto-imports.
      autoImport: false,
    });
    expect(createInputFromForm({ ...base, name: "" })).toEqual({
      error: "Give the calendar a name.",
    });
    expect(
      createInputFromForm({ ...base, refreshIntervalMinutes: "1" }),
    ).toEqual({
      error: "Refresh every 5 to 1440 minutes.",
    });
    expect(describeFetch({ kind: "unchanged" })).toBe(
      "The feed has not changed.",
    );
    expect(
      describeFetch({
        kind: "fetched",
        events: 1,
        counts: {
          components: 3,
          series: 1,
          unsupportedRecurrence: 1,
          unknownTimeZones: 0,
          invalid: 1,
          cancelled: 0,
          truncated: 0,
        },
      }),
    ).toBe(
      "Saved 1 event occurrence; 1 repeating series use rules Tadooer does not expand (first occurrence only); 1 events were skipped as invalid.",
    );
    expect(describeFetch({ kind: "failed", errorClass: "http_404" })).toBe(
      "Fetch failed: the server answered 404.",
    );
    expect(
      describeFetch({ kind: "failed", errorClass: "blocked_address" }),
    ).toBe("Fetch failed: the address resolves to a blocked network location.");
    expect(upcomingWindow(new Date(at))).toEqual({
      from: "2026-09-25T14:00:00.000Z",
      to: "2026-10-02T15:00:00.000Z",
    });
  });
});
