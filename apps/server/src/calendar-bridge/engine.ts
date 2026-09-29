import { randomUUID } from "node:crypto";
import {
  calendarBridgeWritableSides,
  decideCalendarBridgeChange,
  decideCalendarBridgeNewEvent,
  type BridgeObservation as PolicyObservation,
} from "@suite/domain";
import type {
  CalendarBridgeLinkRecord,
  CalendarBridgeMappingRecord,
  CalendarBridgeOperationRecord,
  CalendarBridgeSideState,
  SqliteCalendarBridgeStore,
} from "@suite/persistence";
import { parseEnvelope, serializeEnvelope } from "./envelope.ts";
import type {
  BridgeObservation,
  BridgeReadResult,
  BridgeSide,
  BridgeSideName,
} from "./ports.ts";

/**
 * One synchronization pass for one mapping (ADR 0041). No timers, no retry
 * loops: the #46 worker decides when to call this again. Every local state
 * change is its own transaction; every network write is preceded by a
 * durable `dispatched` mark and followed by a readback.
 */
export interface BridgeRunInput {
  readonly store: SqliteCalendarBridgeStore;
  readonly mapping: CalendarBridgeMappingRecord;
  readonly google: BridgeSide;
  readonly baikal: BridgeSide;
  readonly now: string;
  readonly newId?: () => string;
}

export interface BridgeRunCounts {
  /** Links whose accepted state advanced without a write (includes echoes). */
  settled: number;
  /** Operations enqueued this pass (creates, updates, deletes). */
  enqueued: number;
  /** Operations confirmed and accepted this pass. */
  applied: number;
  /** Operations whose outcome is still unknown. */
  uncertain: number;
  /** Operations that failed a precondition or found the target changed. */
  failed: number;
  conflicts: number;
  blocked: number;
  excluded: number;
}

export type BridgeRunResult =
  | { readonly kind: "completed"; readonly counts: BridgeRunCounts }
  | {
      readonly kind: "failed";
      readonly reason: string;
      readonly counts: BridgeRunCounts;
    }
  | { readonly kind: "disabled" };

const other = (side: BridgeSideName): BridgeSideName =>
  side === "google" ? "baikal" : "google";

const stateOf = (observation: BridgeObservation): CalendarBridgeSideState =>
  observation.kind === "present"
    ? {
        kind: "present",
        revision: observation.revision,
        digest: observation.event.digest,
        snapshot: serializeEnvelope(observation.event.envelope),
      }
    : {
        kind: "deleted",
        revision: observation.proof,
        digest: null,
        snapshot: null,
      };

/** Rebuilds an observation from the last stored side state. */
const fromState = (
  nativeId: string,
  state: CalendarBridgeSideState,
): BridgeObservation | undefined => {
  if (state.kind === "deleted")
    return { kind: "deleted", nativeId, proof: state.revision ?? "gone" };
  if (
    state.kind !== "present" ||
    state.revision === null ||
    state.digest === null ||
    state.snapshot === null
  )
    return undefined;
  const envelope = parseEnvelope(state.snapshot);
  if (envelope === undefined) return undefined;
  return {
    kind: "present",
    nativeId,
    revision: state.revision,
    event: {
      uid: null,
      envelope,
      digest: state.digest,
      unsupportedFields: Object.keys(envelope.unsupported).toSorted(),
      invitationEffect: false,
    },
  };
};

const policyObservation = (observation: BridgeReadResult): PolicyObservation =>
  observation.kind === "present"
    ? {
        kind: "present",
        digest: observation.event.digest,
        revision: observation.revision,
      }
    : observation.kind === "deleted"
      ? { kind: "deleted", proof: observation.proof }
      : { kind: "unavailable" };

const conflictSide = (observation: BridgeObservation) => {
  const state = stateOf(observation);
  return {
    kind: observation.kind,
    revision: state.revision,
    digest: state.digest,
    snapshot: state.snapshot,
  };
};

export const runBridgeOnce = async (
  input: BridgeRunInput,
): Promise<BridgeRunResult> => {
  const { store, mapping, now } = input;
  const newId = input.newId ?? randomUUID;
  const sides: Readonly<Record<BridgeSideName, BridgeSide>> = {
    google: input.google,
    baikal: input.baikal,
  };
  const counts: BridgeRunCounts = {
    settled: 0,
    enqueued: 0,
    applied: 0,
    uncertain: 0,
    failed: 0,
    conflicts: 0,
    blocked: 0,
    excluded: 0,
  };
  if (!mapping.enabled || mapping.removedAt !== null)
    return { kind: "disabled" };

  const nativeIdOf = (
    link: CalendarBridgeLinkRecord,
    side: BridgeSideName,
  ): string | null =>
    side === "google" ? link.googleEventId : link.baikalHref;

  /** Accepts a confirmed target observation for an operation. */
  const complete = (
    operation: CalendarBridgeOperationRecord,
    target: BridgeObservation,
  ): boolean => {
    const link = store.getLink(operation.linkId);
    if (link === undefined) return false;
    const targetState = stateOf(target);
    const sourceState = link[operation.sourceSide];
    const done = store.completeOperation(operation.id, {
      google: operation.target === "google" ? targetState : sourceState,
      baikal: operation.target === "baikal" ? targetState : sourceState,
      accepted:
        operation.action === "delete"
          ? { kind: "deleted" }
          : {
              kind: "present",
              digest: operation.payloadDigest ?? "",
              snapshot: operation.payload ?? "",
            },
      now,
    });
    if (done) {
      counts.applied += 1;
      if (target.kind === "present" && target.event.uid !== null)
        store.setLinkUid(link.id, operation.target, target.event.uid, now);
    }
    return done;
  };

  /** True when the target already shows the operation's intended result. */
  const matches = (
    operation: CalendarBridgeOperationRecord,
    target: BridgeObservation,
  ): boolean =>
    operation.action === "delete"
      ? target.kind === "deleted"
      : target.kind === "present" &&
        target.event.digest === operation.payloadDigest;

  // 1. Reconcile work whose outcome is unknown. Read before any resend.
  for (const operation of store.listUnfinishedOperations(mapping.id)) {
    if (operation.state === "pending") continue;
    const target = await sides[operation.target].read(operation.targetNativeId);
    if (target.kind === "unavailable") {
      store.markUncertain(operation.id, target.reason, now);
      counts.uncertain += 1;
    } else if (matches(operation, target)) complete(operation, target);
    else if (
      operation.action === "create"
        ? target.kind === "deleted"
        : target.kind === "present" &&
          target.revision === operation.expectedRevision
    )
      store.returnToPending(operation.id, "not-applied", now);
    else {
      store.failOperation(operation.id, "target-changed", now);
      counts.failed += 1;
    }
  }

  // 2. Read both sides completely; a failed read ends the pass untouched.
  let googleList = await sides.google.listChanges(mapping.googleCursor);
  if (googleList.kind === "reset-required")
    googleList = await sides.google.listChanges(null);
  if (googleList.kind !== "ok") {
    const reason =
      googleList.kind === "unavailable" ? googleList.reason : "google-reset";
    store.recordRun({
      mappingId: mapping.id,
      now,
      outcome: { kind: "failure", errorCode: reason },
    });
    return { kind: "failed", reason, counts };
  }
  const baikalList = await sides.baikal.listChanges(null);
  if (baikalList.kind !== "ok") {
    const reason =
      baikalList.kind === "unavailable" ? baikalList.reason : "baikal-reset";
    store.recordRun({
      mappingId: mapping.id,
      now,
      outcome: { kind: "failure", errorCode: reason },
    });
    return { kind: "failed", reason, counts };
  }
  const lists = { google: googleList, baikal: baikalList };
  const listed: Record<BridgeSideName, Map<string, BridgeObservation>> = {
    google: new Map(googleList.events.map((event) => [event.nativeId, event])),
    baikal: new Map(baikalList.events.map((event) => [event.nativeId, event])),
  };

  const links = store.listLinks(mapping.id);
  const linked: Record<BridgeSideName, Set<string>> = {
    google: new Set(),
    baikal: new Set(),
  };
  const linkedUids = new Set<string>();
  for (const link of links) {
    if (link.googleEventId !== null) linked.google.add(link.googleEventId);
    if (link.baikalHref !== null) linked.baikal.add(link.baikalHref);
    if (link.googleIcalUid !== null) linkedUids.add(link.googleIcalUid);
    if (link.baikalUid !== null) linkedUids.add(link.baikalUid);
  }

  /** Current observation of one side of a link. */
  const observe = async (
    link: CalendarBridgeLinkRecord,
    side: BridgeSideName,
  ): Promise<BridgeReadResult | undefined> => {
    const nativeId = nativeIdOf(link, side);
    if (nativeId === null) return undefined;
    const reported = listed[side].get(nativeId);
    const stored = link[side];
    let observation: BridgeReadResult | undefined = reported;
    if (observation === undefined && lists[side].incremental)
      observation = fromState(nativeId, stored);
    // A retained tombstone does not need a read on every pass.
    if (observation === undefined && stored.kind === "deleted")
      observation = fromState(nativeId, stored);
    observation ??= await sides[side].read(nativeId);
    if (observation.kind !== "unavailable") {
      store.observeSide(link.id, side, stateOf(observation), now);
      if (observation.kind === "present" && observation.event.uid !== null)
        store.setLinkUid(link.id, side, observation.event.uid, now);
    }
    return observation;
  };

  const writable = calendarBridgeWritableSides(mapping.direction);

  const enqueueCreate = (
    link: CalendarBridgeLinkRecord,
    source: BridgeObservation & { kind: "present" },
  ): void => {
    const target = other(link.origin);
    const targetNativeId = nativeIdOf(link, target);
    if (targetNativeId === null) return;
    const result = store.enqueueOperation({
      link,
      mappingRevision: mapping.revision,
      operation: {
        id: newId(),
        target,
        action: "create",
        targetNativeId,
        targetUid: target === "baikal" ? link.baikalUid : null,
        expectedRevision: null,
        sourceSide: link.origin,
        sourceRevision: source.revision,
        payload: serializeEnvelope(source.event.envelope),
        payloadDigest: source.event.digest,
        reason: "create",
      },
      now,
    });
    if (result !== "busy") counts.enqueued += 1;
  };

  // 3. Linked events.
  for (const link of links) {
    if (link.status === "excluded") continue;
    const google = await observe(link, "google");
    const baikal = await observe(link, "baikal");
    if (store.unfinishedOperationForLink(link.id) !== undefined) continue;
    const current = store.getLink(link.id) ?? link;

    if (current.acceptedKind === "none") {
      // Never accepted: the copy was blocked or its create failed.
      const source = current.origin === "google" ? google : baikal;
      if (source?.kind !== "present") {
        if (source?.kind === "deleted") {
          store.setLinkStatus(
            current.id,
            "excluded",
            "deleted-before-copy",
            now,
          );
          counts.excluded += 1;
        }
        continue;
      }
      const decision = decideCalendarBridgeNewEvent({
        enabled: true,
        direction: mapping.direction,
        source: current.origin,
        initialExclusion: false,
        unsupportedFields: source.event.unsupportedFields,
        invitationEffect: source.event.invitationEffect,
        identityCollision: current.statusReason === "identity-collision",
      });
      if (decision.kind === "create") enqueueCreate(current, source);
      else if (decision.kind === "blocked") {
        store.setLinkStatus(current.id, "blocked", decision.reason, now);
        counts.blocked += 1;
      }
      continue;
    }

    if (google === undefined || baikal === undefined) continue;
    const approval = current.deletionApproval;
    const approvedObservation =
      approval === null
        ? undefined
        : approval.side === "google"
          ? google
          : baikal;
    const presentEvents = [google, baikal].filter(
      (value): value is BridgeObservation & { kind: "present" } =>
        value.kind === "present",
    );
    const decision = decideCalendarBridgeChange({
      enabled: true,
      baseline:
        current.acceptedKind === "present"
          ? { kind: "present", digest: current.acceptedDigest ?? "" }
          : { kind: "deleted" },
      google: policyObservation(google),
      baikal: policyObservation(baikal),
      writable,
      // Any unsupported content on either side blocks: a write built from
      // the envelope could otherwise drop it on the destination.
      unsupportedFields: presentEvents.flatMap(
        (value) => value.event.unsupportedFields,
      ),
      invitationEffect: presentEvents.some(
        (value) => value.event.invitationEffect,
      ),
      deletionApproved:
        approval !== null &&
        approvedObservation?.kind === "deleted" &&
        approvedObservation.proof === approval.proof,
    });
    switch (decision.kind) {
      case "settled": {
        if (
          current.acceptedKind !== decision.accepted.kind ||
          (decision.accepted.kind === "present" &&
            current.acceptedDigest !== decision.accepted.digest) ||
          current.status === "conflict" ||
          current.status === "blocked"
        )
          counts.settled += 1;
        const present = presentEvents[0];
        store.settleLink(
          current.id,
          decision.accepted.kind === "present" && present !== undefined
            ? {
                kind: "present",
                digest: decision.accepted.digest,
                snapshot: serializeEnvelope(present.event.envelope),
              }
            : { kind: "deleted" },
          now,
        );
        break;
      }
      case "propagate": {
        const target = decision.target;
        const source = target === "google" ? baikal : google;
        const targetNativeId = nativeIdOf(current, target);
        if (targetNativeId === null || source.kind === "unavailable") break;
        const result = store.enqueueOperation({
          link: current,
          mappingRevision: mapping.revision,
          operation: {
            id: newId(),
            target,
            action: decision.desired.kind === "deleted" ? "delete" : "update",
            targetNativeId,
            targetUid: target === "baikal" ? current.baikalUid : null,
            expectedRevision: decision.expectedRevision,
            sourceSide: other(target),
            sourceRevision:
              source.kind === "present" ? source.revision : source.proof,
            payload:
              source.kind === "present"
                ? serializeEnvelope(source.event.envelope)
                : null,
            payloadDigest:
              source.kind === "present" ? source.event.digest : null,
            reason: "propagate",
          },
          now,
        });
        if (result !== "busy") counts.enqueued += 1;
        break;
      }
      case "conflict":
        if (google.kind === "unavailable" || baikal.kind === "unavailable")
          break;
        store.openConflict({
          id: newId(),
          link: current,
          reason: decision.reason,
          google: conflictSide(google),
          baikal: conflictSide(baikal),
          now,
        });
        counts.conflicts += 1;
        break;
      case "blocked":
        store.setLinkStatus(current.id, "blocked", decision.reason, now);
        counts.blocked += 1;
        break;
    }
  }

  // 4. Events with no link.
  const initialExclusion =
    mapping.firstPassAt === null && mapping.initialSync === "new_only";
  for (const side of ["google", "baikal"] as const) {
    const target = other(side);
    const unlinkedTargetUids = new Set(
      [...listed[target].values()]
        .filter(
          (event): event is BridgeObservation & { kind: "present" } =>
            event.kind === "present" && !linked[target].has(event.nativeId),
        )
        .map((event) => event.event.uid)
        .filter((uid): uid is string => uid !== null),
    );
    for (const observation of listed[side].values()) {
      if (
        observation.kind !== "present" ||
        linked[side].has(observation.nativeId)
      )
        continue;
      const uid = observation.event.uid;
      const identityCollision =
        (uid !== null &&
          (unlinkedTargetUids.has(uid) || linkedUids.has(uid))) ||
        store.identityLinkedElsewhere({
          ownerId: mapping.ownerId,
          mappingId: mapping.id,
          side,
          nativeId: observation.nativeId,
        });
      const decision = decideCalendarBridgeNewEvent({
        enabled: true,
        direction: mapping.direction,
        source: side,
        initialExclusion,
        unsupportedFields: observation.event.unsupportedFields,
        invitationEffect: observation.event.invitationEffect,
        identityCollision,
      });
      const linkId = newId();
      const targetNativeId =
        decision.kind === "create"
          ? sides[target].reserveNativeId(linkId)
          : null;
      const sourceState = stateOf(observation);
      const unknown: CalendarBridgeSideState = {
        kind: "unknown",
        revision: null,
        digest: null,
        snapshot: null,
      };
      // The Baikal copy keeps the Google iCalUID; Google assigns its own.
      const targetUid =
        decision.kind === "create" && target === "baikal"
          ? (uid ?? `${linkId}@tadooer.bridge`)
          : null;
      const newLink = {
        id: linkId,
        mappingId: mapping.id,
        ownerId: mapping.ownerId,
        origin: side,
        googleEventId:
          side === "google" ? observation.nativeId : targetNativeId,
        googleIcalUid: side === "google" ? uid : null,
        baikalHref: side === "baikal" ? observation.nativeId : targetNativeId,
        baikalUid: side === "baikal" ? uid : targetUid,
        google: side === "google" ? sourceState : unknown,
        baikal: side === "baikal" ? sourceState : unknown,
        status:
          decision.kind === "create"
            ? ("pending" as const)
            : decision.kind === "exclude"
              ? ("excluded" as const)
              : ("blocked" as const),
        statusReason: decision.kind === "create" ? "create" : decision.reason,
        now,
      };
      linked[side].add(observation.nativeId);
      if (uid !== null) linkedUids.add(uid);
      if (decision.kind !== "create" || targetNativeId === null) {
        store.insertLink(newLink);
        if (decision.kind === "exclude") counts.excluded += 1;
        else counts.blocked += 1;
        continue;
      }
      linked[target].add(targetNativeId);
      store.insertLinkWithCreate(
        newLink,
        {
          id: newId(),
          target,
          action: "create",
          targetNativeId,
          targetUid,
          expectedRevision: null,
          sourceSide: side,
          sourceRevision: observation.revision,
          payload: serializeEnvelope(observation.event.envelope),
          payloadDigest: observation.event.digest,
          reason: "create",
        },
        mapping.revision,
      );
      counts.enqueued += 1;
    }
  }

  // Decisions are durable; replaying these changes would settle, not repeat.
  store.recordRun({
    mappingId: mapping.id,
    now,
    outcome: {
      kind: "success",
      googleCursor: googleList.cursor,
      firstPass: true,
    },
  });

  // 5. Dispatch pending work in mapping order.
  for (const operation of store.listUnfinishedOperations(mapping.id)) {
    if (operation.state !== "pending") continue;
    const envelope =
      operation.payload === null ? undefined : parseEnvelope(operation.payload);
    if (operation.action !== "delete" && envelope === undefined) {
      store.failOperation(operation.id, "invalid-payload", now);
      counts.failed += 1;
      continue;
    }
    if (!store.markDispatched(operation.id, now)) continue;
    const side = sides[operation.target];
    const result =
      operation.action === "create" && envelope !== undefined
        ? await side.create(
            operation.targetNativeId,
            operation.targetUid,
            envelope,
          )
        : operation.action === "update" &&
            envelope !== undefined &&
            operation.expectedRevision !== null
          ? await side.update(
              operation.targetNativeId,
              operation.targetUid,
              operation.expectedRevision,
              envelope,
            )
          : operation.expectedRevision !== null
            ? await side.delete(
                operation.targetNativeId,
                operation.expectedRevision,
              )
            : ({ kind: "precondition-failed" } as const);
    switch (result.kind) {
      case "ok":
      case "exists":
      case "gone": {
        if (result.kind === "gone" && operation.action !== "delete") {
          store.failOperation(operation.id, "target-gone", now);
          counts.failed += 1;
          break;
        }
        // A success response is not proof: read the target back.
        const readback = await side.read(operation.targetNativeId);
        if (readback.kind !== "unavailable" && matches(operation, readback))
          complete(operation, readback);
        else if (result.kind === "exists") {
          store.failOperation(operation.id, "identity-exists", now);
          counts.failed += 1;
        } else {
          store.markUncertain(operation.id, "readback-mismatch", now);
          counts.uncertain += 1;
        }
        break;
      }
      case "precondition-failed":
        store.failOperation(operation.id, "precondition-failed", now);
        counts.failed += 1;
        break;
      case "retry":
        store.returnToPending(operation.id, result.reason, now);
        break;
      case "uncertain":
        store.markUncertain(operation.id, result.reason, now);
        counts.uncertain += 1;
        break;
    }
  }
  return { kind: "completed", counts };
};
