import { expect, it } from "vitest";
import {
  calendarBridgeWritableSides,
  decideCalendarBridgeChange as decide,
  decideCalendarBridgeNewEvent,
  type CalendarBridgeNewEventInput,
  type CalendarBridgeInput,
  type BridgeObservation,
} from "./calendar-bridge.ts";
const present = (digest: string, revision: string): BridgeObservation => ({
  kind: "present",
  digest,
  revision,
});
const input = (
  patch: Partial<CalendarBridgeInput> = {},
): CalendarBridgeInput => ({
  enabled: true,
  baseline: { kind: "present", digest: "base" },
  baikal: present("base", '"b1"'),
  google: present("base", '"g1"'),
  writable: { baikal: true, google: true },
  unsupportedFields: [],
  invitation: { baikal: false, google: false },
  deletionApproved: false,
  ...patch,
});
it("accepts semantic echoes without using provider revisions as cross-provider identities", () => {
  expect(decide(input())).toEqual({
    kind: "settled",
    accepted: { kind: "present", digest: "base" },
  });
  expect(
    decide(
      input({ baikal: present("new", '"b2"'), google: present("new", '"g9"') }),
    ),
  ).toEqual({ kind: "settled", accepted: { kind: "present", digest: "new" } });
});
it("propagates one-sided changes with the exact destination revision", () => {
  expect(decide(input({ google: present("new", '"g2"') }))).toEqual({
    kind: "propagate",
    target: "baikal",
    expectedRevision: '"b1"',
    desired: { kind: "present", digest: "new" },
  });
  expect(decide(input({ baikal: present("new", '"b2"') }))).toEqual({
    kind: "propagate",
    target: "google",
    expectedRevision: '"g1"',
    desired: { kind: "present", digest: "new" },
  });
});
it("preserves concurrent edits and deletion-versus-edit conflicts", () => {
  expect(
    decide(
      input({
        baikal: present("b-edit", '"b2"'),
        google: present("g-edit", '"g2"'),
      }),
    ),
  ).toEqual({ kind: "conflict", reason: "concurrent-change" });
  expect(
    decide(
      input({
        baikal: { kind: "deleted", proof: "complete-sync-b2" },
        google: present("g-edit", '"g2"'),
        deletionApproved: true,
      }),
    ).kind,
  ).toBe("conflict");
});
it("requires explicit deletion approval and retains tombstones against resurrection", () => {
  const google = { kind: "deleted", proof: "cancelled-g2" } as const;
  expect(decide(input({ google }))).toEqual({
    kind: "blocked",
    reason: "deletion-approval",
  });
  expect(decide(input({ google, deletionApproved: true }))).toEqual({
    kind: "propagate",
    target: "baikal",
    expectedRevision: '"b1"',
    desired: { kind: "deleted" },
  });
  expect(decide(input({ google, baikal: google }))).toEqual({
    kind: "settled",
    accepted: { kind: "deleted" },
  });
  expect(decide(input({ baseline: { kind: "deleted" } }))).toEqual({
    kind: "conflict",
    reason: "resurrection",
  });
});
it.each([
  [{ enabled: false }, "disabled"],
  [{ google: { kind: "unavailable" } }, "unavailable"],
  [{ unsupportedFields: ["unknown-vendor-field"] }, "unsupported"],
  [
    {
      invitation: { baikal: true, google: false },
      google: present("new", '"g2"'),
    },
    "invitation",
  ],
  [
    {
      writable: { baikal: false, google: true },
      google: present("new", '"g2"'),
    },
    "permission",
  ],
] as const)(
  "blocks unsafe work without offering a write: %j",
  (patch, reason) => {
    expect(decide(input(patch))).toEqual({ kind: "blocked", reason });
  },
);

// Loop freedom (ADR 0041): the bridge's own write, replays and tombstones.
it("settles its own propagated write when read back, even before the receipt", () => {
  // Google edit propagated to Baikal; the receipt was lost, so the baseline is
  // still the old digest. Reading both sides again must not echo-write.
  expect(
    decide(
      input({ google: present("new", '"g2"'), baikal: present("new", '"b7"') }),
    ),
  ).toEqual({ kind: "settled", accepted: { kind: "present", digest: "new" } });
});
it("treats a replayed change notification after acceptance as no work", () => {
  const baseline = { kind: "present", digest: "new" } as const;
  expect(
    decide(
      input({
        baseline,
        google: present("new", '"g2"'),
        baikal: present("new", '"b2"'),
      }),
    ).kind,
  ).toBe("settled");
});
it("keeps a tombstone through replay and reports reappearance on either side", () => {
  const baseline = { kind: "deleted" } as const;
  const gone = { kind: "deleted", proof: "404" } as const;
  expect(decide(input({ baseline, google: gone, baikal: gone }))).toEqual({
    kind: "settled",
    accepted: { kind: "deleted" },
  });
  expect(
    decide(input({ baseline, google: present("base", '"g5"'), baikal: gone })),
  ).toEqual({ kind: "conflict", reason: "resurrection" });
  expect(
    decide(input({ baseline, google: gone, baikal: present("base", '"b5"') })),
  ).toEqual({ kind: "conflict", reason: "resurrection" });
});
it("does not let an unrelated revision change pass as a foreign edit", () => {
  // ETag moved but the semantic digest did not: nothing to propagate.
  expect(decide(input({ google: present("base", '"g9"') })).kind).toBe(
    "settled",
  );
});

const fresh = (
  patch: Partial<CalendarBridgeNewEventInput> = {},
): CalendarBridgeNewEventInput => ({
  enabled: true,
  direction: "two_way",
  source: "google",
  initialExclusion: false,
  unsupportedFields: [],
  identityCollision: false,
  ...patch,
});
it("creates new events on the paired side only", () => {
  expect(decideCalendarBridgeNewEvent(fresh())).toEqual({
    kind: "create",
    target: "baikal",
  });
  expect(decideCalendarBridgeNewEvent(fresh({ source: "baikal" }))).toEqual({
    kind: "create",
    target: "google",
  });
});
it.each([
  [{ enabled: false }, { kind: "blocked", reason: "disabled" }],
  [{ initialExclusion: true }, { kind: "exclude", reason: "initial" }],
  [
    { direction: "baikal_to_google", source: "google" },
    { kind: "exclude", reason: "direction" },
  ],
  [
    { identityCollision: true },
    { kind: "blocked", reason: "identity-collision" },
  ],
  [
    { unsupportedFields: ["recurrence"] },
    { kind: "blocked", reason: "unsupported" },
  ],
] as const)("never creates unsafe copies: %j", (patch, decision) => {
  expect(decideCalendarBridgeNewEvent(fresh(patch))).toEqual(decision);
});
// Invitation events are mirrored read-only (ADR 0042).
it("never writes the side that carries an invitation", () => {
  const invitation = { baikal: false, google: true } as const;
  // Organizer's content change reaches the copy.
  expect(
    decide(input({ invitation, google: present("new", '"g2"') })),
  ).toMatchObject({ kind: "propagate", target: "baikal" });
  // An edit of the copy is not sent back.
  expect(decide(input({ invitation, baikal: present("new", '"b2"') }))).toEqual(
    { kind: "blocked", reason: "invitation" },
  );
  // Nor is a deletion of the copy, even when approved.
  expect(
    decide(
      input({
        invitation,
        baikal: { kind: "deleted", proof: "gone" },
        deletionApproved: true,
      }),
    ),
  ).toEqual({ kind: "blocked", reason: "invitation" });
  // Attendee-only changes do not reach the bridge digest: nothing to do.
  expect(decide(input({ invitation })).kind).toBe("settled");
});
it("derives writable sides from the mapping direction", () => {
  expect(calendarBridgeWritableSides("two_way")).toEqual({
    baikal: true,
    google: true,
  });
  expect(calendarBridgeWritableSides("google_to_baikal")).toEqual({
    baikal: true,
    google: false,
  });
});
