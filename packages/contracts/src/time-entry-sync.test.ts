import { describe, expect, it } from "vitest";
import {
  syncChangeSchema,
  syncDiagnosticOperationSchema,
  syncEntitySnapshotSchema,
  syncOperationEntity,
  syncOperationOutcomeSchema,
  syncOperationSchema,
  syncTimeEntryWindowDays,
  syncTimeEntryWindowStart,
} from "./index.ts";

const id = (tail: string): string =>
  `00000000-0000-4000-8000-0000000000${tail}`;
const at = "2026-10-02T12:00:00.000Z";
const base = {
  operationId: id("01"),
  clientSequence: 1,
  createdAt: at,
  requestHash: "a".repeat(43),
};
const entry = {
  id: id("30"),
  taskId: id("20"),
  workDate: "2026-10-01",
  durationMs: 1_800_000,
  source: "manual",
  revision: 2,
  note: "Review",
  startedAt: null,
  endedAt: null,
  running: false,
  provenance: null,
  createdAt: at,
  updatedAt: at,
};

describe("ADR 0050 time entry sync contracts", () => {
  it("describes create, patch and delete with one base revision", () => {
    const create = {
      ...base,
      kind: "time_entry.create",
      timeEntry: {
        id: id("30"),
        taskId: id("20"),
        workDate: "2026-10-01",
        durationMs: -600_000,
        note: "",
      },
    };
    // A negative duration is a correction (ADR 0024).
    expect(syncOperationSchema.parse(create)).toEqual(create);
    // Every created field is explicit: no default can change the hash.
    for (const key of ["taskId", "workDate", "durationMs", "note"] as const)
      expect(
        syncOperationSchema.safeParse({
          ...create,
          timeEntry: Object.fromEntries(
            Object.entries(create.timeEntry).filter(([name]) => name !== key),
          ),
        }).success,
        key,
      ).toBe(false);
    const rejects = (operation: object) =>
      expect(
        syncOperationSchema.safeParse({ ...base, ...operation }).success,
      ).toBe(false);
    rejects({ ...create, timeEntry: { ...create.timeEntry, durationMs: 0 } });
    rejects({
      ...create,
      timeEntry: { ...create.timeEntry, durationMs: 86_400_001 },
    });
    rejects({
      ...create,
      timeEntry: { ...create.timeEntry, workDate: "2026-02-30" },
    });
    rejects({
      ...create,
      timeEntry: { ...create.timeEntry, note: "x".repeat(501) },
    });
    rejects({ ...create, timeEntry: { ...create.timeEntry, source: "focus" } });

    const patch = {
      ...base,
      kind: "time_entry.patch",
      timeEntryId: id("30"),
      fields: { durationMs: 900_000, workDate: "2026-09-30", note: "Moved" },
      baseRevision: 2,
    };
    expect(syncOperationSchema.parse(patch)).toEqual(patch);
    rejects({ ...patch, fields: {} });
    rejects({ ...patch, fields: { taskId: id("21") } });
    rejects({ ...patch, baseRevision: 0 });
    rejects({ ...patch, baseRevision: undefined });

    const remove = {
      ...base,
      kind: "time_entry.delete",
      timeEntryId: id("30"),
      baseRevision: 3,
    };
    expect(syncOperationSchema.parse(remove)).toEqual(remove);
    rejects({ ...remove, baseRevision: undefined });

    for (const operation of [create, patch, remove])
      expect(syncOperationEntity(syncOperationSchema.parse(operation))).toEqual(
        { entityKind: "time_entry", entityId: id("30") },
      );
  });

  it("carries a stored entry as a snapshot and a change, and a deletion without one", () => {
    const snapshot = { entityKind: "time_entry", value: entry };
    expect(syncEntitySnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(
      syncEntitySnapshotSchema.safeParse({
        entityKind: "time_entry",
        value: { ...entry, durationMs: "long" },
      }).success,
    ).toBe(false);
    const change = {
      sequence: 4,
      entityKind: "time_entry",
      entityId: id("30"),
      kind: "upsert",
      entityRevision: 2,
      changedAt: at,
      snapshot,
    };
    expect(syncChangeSchema.parse(change)).toEqual(change);
    expect(
      syncChangeSchema.parse({ ...change, kind: "deleted", snapshot: null }),
    ).toMatchObject({ kind: "deleted", snapshot: null });
  });

  it("names the broken rule in a conflict outcome and lists the operations in diagnostics", () => {
    expect(
      syncOperationOutcomeSchema.parse({
        kind: "conflict",
        operationId: id("01"),
        code: "SYNC_RESOURCE_CONFLICT",
        entityKind: "time_entry",
        taskId: id("30"),
        taskRevision: 1,
        reasons: ["day_total_exceeds_day"],
      }),
    ).toMatchObject({
      entityKind: "time_entry",
      reasons: ["day_total_exceeds_day"],
    });
    for (const kind of [
      "time_entry.create",
      "time_entry.patch",
      "time_entry.delete",
    ])
      expect(
        syncDiagnosticOperationSchema.safeParse({
          operationId: id("01"),
          entityId: id("30"),
          kind,
          state: "queued",
          requestHash: "a".repeat(43),
          baseRevision: kind === "time_entry.create" ? null : 2,
          safeErrorCode: null,
        }).success,
        kind,
      ).toBe(true);
  });

  it("bounds the snapshot to a rolling window of calendar days", () => {
    expect(syncTimeEntryWindowDays).toBe(90);
    // 90 days counting the last one: the first is 89 days earlier.
    expect(syncTimeEntryWindowStart("2026-10-02")).toBe("2026-07-05");
    expect(syncTimeEntryWindowStart("2026-10-02", 1)).toBe("2026-10-02");
    // Calendar arithmetic across a leap day and a year boundary.
    expect(syncTimeEntryWindowStart("2028-03-01", 2)).toBe("2028-02-29");
    expect(syncTimeEntryWindowStart("2027-01-01", 2)).toBe("2026-12-31");
  });
});
