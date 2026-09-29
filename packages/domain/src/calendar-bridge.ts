/** Pure policy for an already-linked event; no provider I/O or persistence. */
export type BridgeState =
  | { readonly kind: "present"; readonly digest: string }
  | { readonly kind: "deleted" };
export type BridgeObservation =
  | {
      readonly kind: "present";
      readonly digest: string;
      readonly revision: string;
    }
  | { readonly kind: "deleted"; readonly proof: string }
  | { readonly kind: "unavailable" };
export interface CalendarBridgeInput {
  readonly enabled: boolean;
  readonly baseline: BridgeState;
  readonly baikal: BridgeObservation;
  readonly google: BridgeObservation;
  readonly writable: { readonly baikal: boolean; readonly google: boolean };
  readonly unsupportedFields: readonly string[];
  readonly invitationEffect: boolean;
  readonly deletionApproved: boolean;
}
export type CalendarBridgeDecision =
  | {
      readonly kind: "blocked";
      readonly reason:
        | "disabled"
        | "unavailable"
        | "unsupported"
        | "invitation"
        | "permission"
        | "deletion-approval";
    }
  | {
      readonly kind: "conflict";
      readonly reason: "concurrent-change" | "resurrection";
    }
  | { readonly kind: "settled"; readonly accepted: BridgeState }
  | {
      readonly kind: "propagate";
      readonly target: "baikal" | "google";
      readonly expectedRevision: string;
      readonly desired: BridgeState;
    };

const same = (a: BridgeState, b: BridgeState): boolean =>
  a.kind === b.kind &&
  (a.kind === "deleted" || (b.kind === "present" && a.digest === b.digest));
const state = (
  value: Exclude<BridgeObservation, { kind: "unavailable" }>,
): BridgeState =>
  value.kind === "deleted"
    ? { kind: "deleted" }
    : { kind: "present", digest: value.digest };

export const decideCalendarBridgeChange = (
  input: CalendarBridgeInput,
): CalendarBridgeDecision => {
  if (!input.enabled) return { kind: "blocked", reason: "disabled" };
  if (
    input.baikal.kind === "unavailable" ||
    input.google.kind === "unavailable"
  )
    return { kind: "blocked", reason: "unavailable" };
  if (input.unsupportedFields.length > 0)
    return { kind: "blocked", reason: "unsupported" };
  if (input.invitationEffect) return { kind: "blocked", reason: "invitation" };
  const b = state(input.baikal);
  const g = state(input.google);
  // A retained tombstone may never be silently revived, even on both sides.
  if (
    input.baseline.kind === "deleted" &&
    (b.kind === "present" || g.kind === "present")
  )
    return { kind: "conflict", reason: "resurrection" };
  if (same(b, g)) return { kind: "settled", accepted: b };
  if (!same(b, input.baseline) && !same(g, input.baseline))
    return { kind: "conflict", reason: "concurrent-change" };
  const target = same(b, input.baseline) ? "baikal" : "google";
  const observed = input[target];
  const desired = target === "baikal" ? g : b;
  if (!input.writable[target]) return { kind: "blocked", reason: "permission" };
  if (desired.kind === "deleted" && !input.deletionApproved)
    return { kind: "blocked", reason: "deletion-approval" };
  // A missing destination is not a new-event instruction for this linked-event policy.
  if (observed.kind !== "present")
    return { kind: "conflict", reason: "concurrent-change" };
  return {
    kind: "propagate",
    target,
    expectedRevision: observed.revision,
    desired,
  };
};

export type CalendarBridgeSide = "google" | "baikal";
export type CalendarBridgeDirection =
  "two_way" | "google_to_baikal" | "baikal_to_google";

/** Sides a mapping direction may write to (ADR 0041). */
export const calendarBridgeWritableSides = (
  direction: CalendarBridgeDirection,
): { readonly baikal: boolean; readonly google: boolean } => ({
  baikal: direction !== "baikal_to_google",
  google: direction !== "google_to_baikal",
});

export interface CalendarBridgeNewEventInput {
  readonly enabled: boolean;
  readonly direction: CalendarBridgeDirection;
  readonly source: CalendarBridgeSide;
  /** First pass of a mapping created with `new_only`. */
  readonly initialExclusion: boolean;
  readonly unsupportedFields: readonly string[];
  readonly invitationEffect: boolean;
  /** Same UID unlinked on the other side, or identity already linked elsewhere. */
  readonly identityCollision: boolean;
}

export type CalendarBridgeNewEventDecision =
  | { readonly kind: "create"; readonly target: CalendarBridgeSide }
  | { readonly kind: "exclude"; readonly reason: "initial" | "direction" }
  | {
      readonly kind: "blocked";
      readonly reason:
        "disabled" | "unsupported" | "invitation" | "identity-collision";
    };

/**
 * Pure policy for an event observed on one side with no event link. It never
 * matches by title or time and never adopts an existing UID (ADR 0017/0041).
 */
export const decideCalendarBridgeNewEvent = (
  input: CalendarBridgeNewEventInput,
): CalendarBridgeNewEventDecision => {
  if (!input.enabled) return { kind: "blocked", reason: "disabled" };
  if (input.initialExclusion) return { kind: "exclude", reason: "initial" };
  const target = input.source === "google" ? "baikal" : "google";
  if (!calendarBridgeWritableSides(input.direction)[target])
    return { kind: "exclude", reason: "direction" };
  if (input.identityCollision)
    return { kind: "blocked", reason: "identity-collision" };
  if (input.unsupportedFields.length > 0)
    return { kind: "blocked", reason: "unsupported" };
  if (input.invitationEffect) return { kind: "blocked", reason: "invitation" };
  return { kind: "create", target };
};
