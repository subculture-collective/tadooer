import { describe, expect, it } from "vitest";
import {
  clientSyncRoundResponseSchema,
  clientSyncSnapshotResponseSchema,
  liveSyncResourceFamilySchema,
  syncChangeSchema,
  syncDiagnosticManifestSchema,
  syncDiagnosticOperationSchema,
  syncEntityKindsSignature,
  syncEntitySnapshotSchema,
  syncKnownEntityKinds,
  syncOperationEntity,
  syncOperationOutcomeSchema,
  syncOperationSchema,
  syncRoundResponseSchema,
  syncSnapshotResponseSchema,
} from "./index.ts";

const id = (tail: string): string =>
  `00000000-0000-4000-8000-0000000000${tail}`;
const at = "2026-10-02T12:00:00.000Z";
const date = "2026-10-03";
const base = {
  operationId: id("01"),
  clientSequence: 1,
  createdAt: at,
  requestHash: "a".repeat(43),
};
const saved = {
  date,
  revision: 2,
  taskIds: [id("21"), id("20")],
  updatedAt: at,
};

describe("ADR 0050 day-order sync contracts", () => {
  it("describes a reorder with the date, the full order and one base revision", () => {
    const reorder = {
      ...base,
      kind: "day_order.reorder",
      date,
      taskIds: [id("20"), id("21")],
      baseRevision: 0,
    };
    // Base revision 0 is a first reorder of a date with no saved order.
    expect(syncOperationSchema.parse(reorder)).toEqual(reorder);
    expect(syncOperationEntity(syncOperationSchema.parse(reorder))).toEqual({
      entityKind: "day_order",
      entityId: date,
    });
    const rejects = (fields: object) =>
      expect(
        syncOperationSchema.safeParse({ ...reorder, ...fields }).success,
      ).toBe(false);
    rejects({ baseRevision: -1 });
    rejects({ baseRevision: undefined });
    rejects({ date: "2026-02-30" });
    rejects({ taskIds: [id("20"), id("20")] });
    rejects({ taskIds: ["not-a-uuid"] });
    rejects({ taskIds: Array.from({ length: 501 }, () => id("20")) });
    // An empty order is valid: every task may have left the day.
    expect(
      syncOperationSchema.safeParse({ ...reorder, taskIds: [] }).success,
    ).toBe(true);
  });

  it("carries the saved ranks as a snapshot and a change keyed by the date", () => {
    const snapshot = { entityKind: "day_order", value: saved };
    expect(syncEntitySnapshotSchema.parse(snapshot)).toEqual(snapshot);
    // A saved order exists only after a first write, so revision 0 is not one.
    expect(
      syncEntitySnapshotSchema.safeParse({
        entityKind: "day_order",
        value: { ...saved, revision: 0 },
      }).success,
    ).toBe(false);
    const change = {
      sequence: 4,
      entityKind: "day_order",
      entityId: date,
      kind: "upsert",
      entityRevision: 2,
      changedAt: at,
      snapshot,
    };
    expect(syncChangeSchema.parse(change)).toEqual(change);
    // The key is a UUID or a calendar date, nothing else.
    expect(
      syncChangeSchema.safeParse({ ...change, entityId: "tomorrow" }).success,
    ).toBe(false);
  });

  it("reports outcomes and diagnostics for a record keyed by a date", () => {
    expect(
      syncOperationOutcomeSchema.parse({
        kind: "applied",
        operationId: id("01"),
        entityId: date,
        entityRevision: 1,
        changeSequence: 3,
      }),
    ).toMatchObject({ entityId: date });
    expect(
      syncOperationOutcomeSchema.parse({
        kind: "conflict",
        operationId: id("01"),
        code: "SYNC_RESOURCE_CONFLICT",
        entityKind: "day_order",
        taskId: date,
        taskRevision: 3,
        reasons: ["revision"],
      }),
    ).toMatchObject({ entityKind: "day_order", reasons: ["revision"] });
    const operation = {
      operationId: id("01"),
      entityId: date,
      kind: "day_order.reorder",
      state: "queued",
      requestHash: "a".repeat(43),
      baseRevision: 0,
      safeErrorCode: null,
    };
    expect(syncDiagnosticOperationSchema.parse(operation)).toEqual(operation);
    expect(
      syncDiagnosticManifestSchema.parse({
        schemaVersion: "suite-sync-diagnostics-v1",
        exportedAt: at,
        installationId: id("02"),
        clientId: id("03"),
        cursor: null,
        pendingOperationCount: 1,
        conflictCount: 0,
        skippedUnknownKindCount: 2,
        operations: [operation],
      }).skippedUnknownKindCount,
    ).toBe(2);
  });

  it("keeps the retired day_orders family in the contract enum", () => {
    expect(liveSyncResourceFamilySchema.safeParse("day_orders").success).toBe(
      true,
    );
  });
});

describe("ADR 0050 unknown entity kinds", () => {
  const response = {
    protocolVersion: 2,
    outcomes: [],
    nextCursor: "sync-v1.epoch.9.tag",
    hasMore: false,
    serverTimestamp: at,
  };
  const known = {
    sequence: 8,
    entityKind: "day_order",
    entityId: date,
    kind: "upsert",
    entityRevision: 2,
    changedAt: at,
    snapshot: { entityKind: "day_order", value: saved },
  };
  const unknown = {
    sequence: 9,
    entityKind: "kanban_lane",
    entityId: id("40"),
    kind: "upsert",
    entityRevision: 1,
    changedAt: at,
    snapshot: { entityKind: "kanban_lane", value: { id: id("40") } },
  };

  it("names the kinds a build knows in a stable signature", () => {
    expect(syncKnownEntityKinds).toContain("day_order");
    expect(syncKnownEntityKinds).not.toContain("kanban_lane");
    expect(syncEntityKindsSignature).toBe(
      [...syncKnownEntityKinds].sort().join(","),
    );
  });

  it("lets a client skip and count a change of a kind it does not know", () => {
    const round = { ...response, changes: [known, unknown] };
    // The server contract is strict: an unknown kind is not a valid round.
    expect(syncRoundResponseSchema.safeParse(round).success).toBe(false);
    const parsed = clientSyncRoundResponseSchema.parse(round);
    expect(parsed.changes).toEqual([known]);
    expect(parsed.skippedUnknownKinds).toBe(1);
    // The cursor of the round is kept, so the client advances past it.
    expect(parsed.nextCursor).toBe(response.nextCursor);
    expect(
      clientSyncRoundResponseSchema.parse({ ...response, changes: [known] })
        .skippedUnknownKinds,
    ).toBe(0);
  });

  it("still rejects a malformed change of a known kind", () => {
    for (const broken of [
      { ...known, entityRevision: 0 },
      { ...known, snapshot: { entityKind: "day_order", value: {} } },
      { ...known, entityKind: undefined },
      "not a change",
    ])
      expect(
        clientSyncRoundResponseSchema.safeParse({
          ...response,
          changes: [broken],
        }).success,
      ).toBe(false);
  });

  it("skips and counts snapshot records of an unknown kind", () => {
    const page = {
      protocolVersion: 2,
      nextCursor: response.nextCursor,
      hasMore: true,
      serverTimestamp: at,
      snapshots: [
        { entityKind: "day_order", value: saved },
        { entityKind: "kanban_lane", value: { id: id("40") } },
        { entityKind: "kanban_lane", value: { id: id("41") } },
      ],
    };
    expect(syncSnapshotResponseSchema.safeParse(page).success).toBe(false);
    const parsed = clientSyncSnapshotResponseSchema.parse(page);
    expect(parsed.snapshots).toEqual([
      { entityKind: "day_order", value: saved },
    ]);
    expect(parsed.skippedUnknownKinds).toBe(2);
    expect(
      clientSyncSnapshotResponseSchema.safeParse({
        ...page,
        snapshots: [{ entityKind: "day_order", value: { date } }],
      }).success,
    ).toBe(false);
  });
});
