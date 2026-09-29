import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CalendarBridgeBlockedEvent,
  CalendarBridgeMappingPreviewResponse,
  CalendarBridgeMappingSummary,
  CalendarBridgeReviewResponse,
  GoogleConnectorStatusResponse,
} from "@suite/contracts";
import {
  decideCalendarBridgeDeletion,
  removeCalendarBridgeMapping,
  resolveCalendarBridgeConflict,
} from "../api.ts";
import { CalendarBridgeView } from "./CalendarBridge.tsx";
import {
  allowedDirections,
  blockedReasonText,
  copySummary,
  emptyMappingForm,
  googleCalendarChoices,
  mappingInputFromForm,
  previewMatches,
  removalPlan,
  reviewActionText,
  runOutcomeText,
  versionLines,
} from "./calendar-bridge-controller.ts";

// Calendar bridge controls (issue #48, ADR 0044).
const at = "2026-09-29T12:00:00.000Z";
const googleId = "00000000-0000-4000-8000-000000000001";
const baikalId = "00000000-0000-4000-8000-000000000002";
const readOnlyId = "00000000-0000-4000-8000-000000000003";
const mappingId = "00000000-0000-4000-8000-000000000010";
const linkId = "00000000-0000-4000-8000-000000000020";
const conflictId = "00000000-0000-4000-8000-000000000030";

const counts = {
  links: 4,
  active: 1,
  pendingWrites: 2,
  inFlightWrites: 0,
  retryingWrites: 0,
  blocked: 2,
  pendingDeletions: 1,
  conflicts: 1,
  excluded: 0,
  tombstoned: 0,
};
const mapping: CalendarBridgeMappingSummary = {
  id: mappingId,
  revision: 2,
  googleCalendarId: googleId,
  googleCalendarRef: "owner@example.test",
  baikalCalendarId: baikalId,
  baikalCalendarRef: "/dav.php/calendars/alice/work/",
  direction: "two_way",
  initialSync: "copy_existing",
  enabled: true,
  firstPassAt: at,
  lastRunAt: at,
  lastSuccessAt: at,
  lastErrorCode: null,
  createdAt: at,
  updatedAt: at,
  googleCalendarName: "Primary",
  baikalCalendarName: "Work",
  state: "needs-review",
  stale: false,
  attention: ["conflicts", "deletions-awaiting-approval", "blocked-events"],
  counts,
};
const paused: CalendarBridgeMappingSummary = {
  ...mapping,
  id: "00000000-0000-4000-8000-000000000011",
  enabled: false,
  state: "paused",
  googleCalendarName: null,
  lastErrorCode: "google-reconnect-required",
  attention: ["paused", "google-reconnect-required", "last-pass-failed"],
  counts: { ...counts, pendingWrites: 0, inFlightWrites: 1 },
};
const version = {
  revision: '"r1"',
  description: null,
  allDay: false,
  end: "2026-10-01T10:00:00.000Z",
  unsupported: [],
};
const dentist: CalendarBridgeBlockedEvent = {
  linkId,
  linkRevision: 5,
  title: "Dentist",
  start: "2026-10-02T08:00:00.000Z",
  allDay: false,
  origin: "google",
  reason: "deletion-approval",
  deletedOn: "google",
  approved: false,
};
const review: CalendarBridgeReviewResponse = {
  mapping,
  blocked: [
    dentist,
    {
      linkId: "00000000-0000-4000-8000-000000000021",
      linkRevision: 1,
      title: "Standup",
      start: "2026-10-03",
      allDay: true,
      origin: "baikal",
      reason: "unsupported",
      deletedOn: null,
      approved: false,
    },
  ],
  conflicts: [
    {
      id: conflictId,
      linkId,
      linkRevision: 7,
      reason: "concurrent-change",
      title: "Planning",
      createdAt: at,
      google: {
        ...version,
        kind: "present",
        summary: "Planning (Google)",
        location: "Room 1",
        start: "2026-10-01T09:00:00.000Z",
        unsupported: ["reminders"],
      },
      baikal: {
        ...version,
        kind: "present",
        summary: "Planning (Baikal)",
        location: null,
        start: "2026-10-01T09:30:00.000Z",
      },
    },
  ],
  operations: [
    {
      id: "00000000-0000-4000-8000-000000000040",
      linkId,
      sequence: 3,
      target: "baikal",
      action: "update",
      reason: "propagate",
      state: "pending",
      attempts: 1,
      lastError: "authorization",
      updatedAt: at,
      title: "Lunch",
    },
  ],
};
const googleStatus = {
  calendars: [
    {
      id: googleId,
      providerId: googleId,
      href: "owner@example.test",
      displayName: "Primary",
      supportsEvents: true,
      supportsTodos: false,
    },
    {
      id: readOnlyId,
      providerId: googleId,
      href: "holidays@example.test",
      displayName: "Holidays",
      supportsEvents: true,
      supportsTodos: false,
    },
  ],
  capabilities: [
    { calendarId: googleId, accessRole: "owner", writable: true, reason: null },
    {
      calendarId: readOnlyId,
      accessRole: "reader",
      writable: false,
      reason: "read-only-calendar",
    },
  ],
} as unknown as GoogleConnectorStatusResponse;
const preview: CalendarBridgeMappingPreviewResponse = {
  direction: "two_way",
  initialSync: "copy_existing",
  refusals: [],
  copies: [
    {
      from: "google",
      to: "baikal",
      existing: 12,
      copied: 12,
      repeating: 2,
      sample: [
        {
          summary: "Planning",
          startsAt: "2026-10-01T09:00:00.000Z",
          allDay: false,
        },
      ],
      readAt: at,
    },
    {
      from: "baikal",
      to: "google",
      existing: 0,
      copied: 0,
      repeating: 0,
      sample: [],
      readAt: null,
    },
  ],
};
const request = {
  googleCalendarId: googleId,
  baikalCalendarId: baikalId,
  direction: "two_way",
  initialSync: "copy_existing",
} as const;

const view = (props: Partial<Parameters<typeof CalendarBridgeView>[0]> = {}) =>
  renderToStaticMarkup(
    <CalendarBridgeView
      googleChoices={googleCalendarChoices(googleStatus)}
      baikalChoices={[
        {
          id: baikalId,
          providerId: baikalId,
          href: "/dav.php/calendars/alice/work/",
          displayName: "Work",
          supportsEvents: true,
          supportsTodos: false,
        },
      ]}
      writeConsent
      form={emptyMappingForm}
      preview={null}
      previewCurrent={false}
      mappings={[mapping, paused]}
      reviews={{}}
      pendingRemoval={null}
      pendingAction={null}
      busy={false}
      message={null}
      error={null}
      onFormChange={vi.fn()}
      onPreview={vi.fn()}
      onCreate={vi.fn()}
      onRun={vi.fn()}
      onToggleEnabled={vi.fn()}
      onToggleReview={vi.fn()}
      onRequestRemove={vi.fn()}
      onDiscardPendingChange={vi.fn()}
      onConfirmRemove={vi.fn()}
      onCancelRemove={vi.fn()}
      onRequestAction={vi.fn()}
      onConfirmAction={vi.fn()}
      onCancelAction={vi.fn()}
      {...props}
    />,
  );

afterEach(() => vi.unstubAllGlobals());

describe("calendar bridge controls", () => {
  it("shows each mapping's state, last pass, pending work and recovery actions", () => {
    const markup = view();
    for (const text of [
      "Calendar bridge",
      "Primary",
      "Work",
      "Needs review",
      "Both ways",
      "Copy existing events",
      "2 pending writes",
      "1 conflict",
      "1 deletion",
      "1 blocked event",
      "Both calendars changed the same event; choose a version.",
      "Run pass now",
      "Pause",
      "Review",
      "Remove",
      "Paused",
      "Resume",
      "Unavailable Google calendar",
      "failed: Google needs to be reconnected",
      "Google rejected the stored grant",
      "Holidays (read only: read-only for you)",
      "Primary (writable)",
    ])
      expect(markup).toContain(text);
    // The initial-sync choice has no default and nothing can be created
    // before a preview.
    expect(markup).not.toMatch(/name="bridge-initial-sync"[^>]*checked/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Create mapping/);
    expect(view({ mappings: [] })).toContain("No calendar mappings yet.");
    expect(view({ writeConsent: false })).toContain(
      "Allow Google event changes above",
    );
  });

  it("shows the preview of what a mapping would copy before creation", () => {
    const markup = view({
      form: { ...request },
      preview,
      previewCurrent: true,
    });
    for (const text of [
      "What this mapping would do",
      "Google to Baikal: 12 existing events would be copied",
      "2 repeating events may be held for review instead.",
      "Baikal to Google: 0 existing events would be copied",
      "Tadooer has not read the Baikal calendar yet",
      "Planning",
      "and 11 more events",
      "Counts come from the events Tadooer last read",
    ])
      expect(markup).toContain(text);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>Create mapping/);
    const refused = view({
      form: { ...request },
      preview: { ...preview, refusals: ["google-calendar-not-writable"] },
      previewCurrent: true,
    });
    expect(refused).toContain("This Google calendar is read-only");
    expect(refused).toMatch(/<button[^>]*disabled=""[^>]*>Create mapping/);
  });

  it("reviews conflicts with both versions, deletions and blocked events", () => {
    const markup = view({ reviews: { [mappingId]: review } });
    for (const text of [
      "Conflicts",
      "Google version",
      "Baikal version",
      "Title: Planning (Google)",
      "Title: Planning (Baikal)",
      "Where: Room 1",
      "Not copied: reminders",
      "Keep Google version",
      "Keep Baikal version",
      "Deletions awaiting approval",
      "Dentist",
      "Deleted in Google. The other copy stays until you decide.",
      "Approve deletion",
      "Keep the other copy",
      "Blocked events",
      "Standup",
      "Uses content the bridge does not copy yet",
      "Pending writes",
      "Update &quot;Lunch&quot; in Baikal",
      "last attempt failed (authorization)",
      "Hide review",
    ])
      expect(markup).toContain(text);
  });

  it("confirms review decisions and removal with their effect named", () => {
    const deletion = view({
      pendingAction: {
        kind: "deletion",
        mappingId,
        event: dentist,
        decision: "approve",
      },
    });
    expect(deletion).toContain('role="alertdialog"');
    expect(deletion).toContain(
      "Delete the Baikal copy of &quot;Dentist&quot; too?",
    );
    const resolve = view({
      pendingAction: {
        kind: "resolve",
        mappingId,
        conflictId,
        linkRevision: 7,
        title: "Planning",
        keep: "baikal",
        keptDeleted: false,
      },
    });
    expect(resolve).toContain(
      "Keep the Baikal version of &quot;Planning&quot;?",
    );
    const pending = view({
      pendingRemoval: { mapping, discardPending: false },
    });
    expect(pending).toContain("No events are deleted from either calendar.");
    expect(pending).toContain("Discard 2 pending writes");
    expect(pending).toMatch(/<button[^>]*disabled=""[^>]*>Remove mapping/);
    expect(
      view({ pendingRemoval: { mapping, discardPending: true } }),
    ).not.toMatch(/<button[^>]*disabled=""[^>]*>Remove mapping/);
    const inFlight = view({
      pendingRemoval: { mapping: paused, discardPending: true },
    });
    expect(inFlight).toContain("Run a pass first");
    expect(inFlight).toMatch(/<button[^>]*disabled=""[^>]*>Remove mapping/);
  });

  it("derives choices, validation and messages without a server", () => {
    const choices = googleCalendarChoices(googleStatus);
    expect(allowedDirections(choices[1])).toEqual(["google_to_baikal"]);
    expect(allowedDirections(choices[0])).toHaveLength(3);
    expect(mappingInputFromForm({ ...request, initialSync: "" })).toEqual({
      error: "Choose what happens to existing events.",
    });
    expect(mappingInputFromForm({ ...request, direction: "" })).toEqual({
      error: "Choose a direction.",
    });
    expect(mappingInputFromForm(request)).toEqual(request);
    // A preview only counts for the exact values it was made for.
    expect(previewMatches(preview, request, request)).toBe(true);
    expect(
      previewMatches(preview, { ...request, initialSync: "new_only" }, request),
    ).toBe(false);
    expect(copySummary({ ...preview, initialSync: "new_only" })[0]).toContain(
      "none of the 12 existing events are copied",
    );
    expect(removalPlan(mapping)).toEqual({ kind: "pending", count: 2 });
    expect(removalPlan(paused)).toEqual({ kind: "in-flight", count: 1 });
    expect(
      removalPlan({
        ...mapping,
        counts: { ...counts, pendingWrites: 0 },
      }),
    ).toEqual({ kind: "clear" });
    expect(blockedReasonText({ ...dentist, approved: true })).toContain(
      "approved; the next pass deletes the other copy",
    );
    expect(
      reviewActionText({
        kind: "deletion",
        mappingId,
        event: dentist,
        decision: "decline",
      }),
    ).toContain("Nothing is written to either calendar.");
    expect(
      versionLines({
        ...version,
        kind: "deleted",
        summary: null,
        location: null,
        start: null,
      }),
    ).toEqual(["Deleted"]);
    expect(
      runOutcomeText({
        outcome: "blocked",
        reason: "google-consent-required",
        counts: null,
        mapping,
      }),
    ).toBe("The pass could not start: Google event changes are not allowed.");
  });

  it("sends revision-bound review and removal requests", async () => {
    const fetcher = vi.fn((path: string, init: RequestInit = {}) => {
      void init;
      if (init.method === "DELETE")
        return Promise.resolve(new Response(null, { status: 204 }));
      const body = path.endsWith("/resolve")
        ? {
            operation: {
              id: linkId,
              linkId,
              sequence: 1,
              target: "google",
              action: "update",
              reason: "resolution",
              state: "pending",
              attempts: 0,
              lastError: null,
              updatedAt: at,
            },
          }
        : {
            link: {
              id: linkId,
              revision: 6,
              origin: "google",
              googleEventId: "evt",
              googleIcalUid: null,
              baikalHref: null,
              baikalUid: null,
              google: { kind: "deleted", revision: "p", digest: null },
              baikal: { kind: "present", revision: '"b"', digest: "d" },
              acceptedKind: "present",
              acceptedDigest: "d",
              status: "excluded",
              statusReason: "deletion-declined",
              deletionApproval: null,
              updatedAt: at,
            },
          };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetcher);
    await decideCalendarBridgeDeletion(mappingId, linkId, 5, "decline", "csrf");
    await resolveCalendarBridgeConflict(
      mappingId,
      conflictId,
      7,
      "baikal",
      "csrf",
    );
    await removeCalendarBridgeMapping(mappingId, 2, true, "csrf");
    await removeCalendarBridgeMapping(mappingId, 2, false, "csrf");
    const [decline, resolve, discard, keep] = fetcher.mock.calls;
    expect(decline?.[0]).toBe(
      `/api/calendar-bridge/mappings/${mappingId}/links/${linkId}/decline-deletion`,
    );
    expect(new Headers(decline?.[1]?.headers).get("if-match")).toBe('"5"');
    expect(resolve?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ keep: "baikal" }),
    });
    expect(new Headers(resolve?.[1]?.headers).get("if-match")).toBe('"7"');
    expect(discard?.[0]).toBe(
      `/api/calendar-bridge/mappings/${mappingId}?pendingWork=cancel`,
    );
    expect(keep?.[0]).toBe(`/api/calendar-bridge/mappings/${mappingId}`);
  });
});
