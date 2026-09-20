import { expect, it } from "vitest";
import {
  decideCalendarBridgeChange as decide,
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
  invitationEffect: false,
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
  [{ invitationEffect: true }, "invitation"],
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
