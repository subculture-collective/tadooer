import { describe, expect, it } from "vitest";
import {
  coreTaskFieldSchema,
  syncDiagnosticOperationSchema,
  syncFieldVersionKey,
  syncOperationEntity,
  syncOperationOutcomeSchema,
  syncOperationSchema,
  taskFieldVersionsSchema,
} from "./index.ts";

const id = (tail: string): string =>
  `00000000-0000-4000-8000-0000000000${tail}`;
const base = {
  operationId: id("01"),
  clientSequence: 1,
  createdAt: "2026-09-25T12:00:00.000Z",
  requestHash: "a".repeat(43),
};

describe("ADR 0033 sync operation contracts", () => {
  it("versions the planning slot once and maps planned day onto it", () => {
    expect(coreTaskFieldSchema.options).toContain("plannedStart");
    expect(syncFieldVersionKey("plannedDay")).toBe("plannedStart");
    expect(syncFieldVersionKey("title")).toBe("title");
    expect(
      taskFieldVersionsSchema.safeParse({
        title: 1,
        notes: 1,
        status: 1,
        estimateMinutes: 1,
        projectId: 1,
        tagIds: 1,
        deadline: 1,
      }).success,
    ).toBe(true);
    const patch = (fields: unknown, baseFieldVersions: unknown) =>
      syncOperationSchema.safeParse({
        ...base,
        kind: "task.patch",
        taskId: id("02"),
        fields,
        baseFieldVersions,
      }).success;
    expect(patch({ plannedDay: "2026-09-26" }, { plannedStart: 3 })).toBe(true);
    expect(
      patch({ plannedStart: null, plannedDay: null }, { plannedStart: 3 }),
    ).toBe(true);
    expect(patch({ plannedDay: "2026-09-26" }, { plannedDay: 3 })).toBe(false);
    expect(
      patch(
        { plannedStart: base.createdAt, plannedDay: "2026-09-26" },
        { plannedStart: 3 },
      ),
    ).toBe(false);
    expect(
      patch(
        { projectId: id("03"), tagIds: [id("04"), id("05")] },
        { projectId: 1, tagIds: 1 },
      ),
    ).toBe(true);
    expect(patch({ tagIds: [id("04"), id("04")] }, { tagIds: 1 })).toBe(false);
    expect(patch({ projectId: null }, { projectId: 1, tagIds: 1 })).toBe(false);
    expect(patch({ startReminder: { kind: "none" } }, {})).toBe(false);
  });

  it("describes project, tag and checklist operations with one base revision", () => {
    const accepted = [
      { kind: "project.create", project: { id: id("10"), title: "Home" } },
      { kind: "tag.create", tag: { id: id("11"), title: "errand" } },
      {
        kind: "project.patch",
        projectId: id("10"),
        fields: { title: "House", completed: true, color: "#112233" },
        baseRevision: 2,
      },
      {
        kind: "tag.patch",
        tagId: id("11"),
        fields: { archived: true },
        baseRevision: 1,
      },
      {
        kind: "subtask.create",
        subtask: { id: id("12"), taskId: id("02"), title: "Step", position: 0 },
      },
      {
        kind: "subtask.patch",
        subtaskId: id("12"),
        fields: { completed: true, position: 1 },
        baseRevision: 1,
      },
      { kind: "subtask.delete", subtaskId: id("12"), baseRevision: 2 },
    ];
    for (const operation of accepted) {
      const parsed = syncOperationSchema.safeParse({ ...base, ...operation });
      expect(parsed.success, operation.kind).toBe(true);
      expect(
        syncDiagnosticOperationSchema.shape.kind.safeParse(operation.kind)
          .success,
      ).toBe(true);
    }
    const rejected = [
      {
        kind: "project.patch",
        projectId: id("10"),
        fields: { archived: true, completed: true },
        baseRevision: 2,
      },
      {
        kind: "project.patch",
        projectId: id("10"),
        fields: {},
        baseRevision: 2,
      },
      {
        kind: "tag.patch",
        tagId: id("11"),
        fields: { completed: true },
        baseRevision: 1,
      },
      {
        kind: "tag.patch",
        tagId: id("11"),
        fields: { title: "x".repeat(101) },
        baseRevision: 1,
      },
      { kind: "tag.create", tag: { id: id("11"), title: "" } },
      {
        kind: "subtask.create",
        subtask: {
          id: id("12"),
          taskId: id("02"),
          title: "Step",
          position: -1,
        },
      },
      {
        kind: "subtask.patch",
        subtaskId: id("12"),
        fields: {},
        baseRevision: 1,
      },
      { kind: "subtask.delete", subtaskId: id("12"), baseRevision: 0 },
    ];
    for (const operation of rejected)
      expect(
        syncOperationSchema.safeParse({ ...base, ...operation }).success,
        JSON.stringify(operation),
      ).toBe(false);
  });

  it("names the conflicting entity in outcomes and resolves the entity of every operation", () => {
    expect(
      syncOperationOutcomeSchema.parse({
        kind: "conflict",
        operationId: id("01"),
        code: "SYNC_RESOURCE_CONFLICT",
        entityKind: "project",
        taskId: id("10"),
        taskRevision: 2,
      }),
    ).toMatchObject({ entityKind: "project" });
    expect(
      syncOperationOutcomeSchema.safeParse({
        kind: "conflict",
        operationId: id("01"),
        code: "SYNC_FIELD_CONFLICT",
        taskId: id("02"),
        taskRevision: 2,
        conflictingFields: ["plannedStart", "projectId"],
      }).success,
    ).toBe(true);
    expect(
      syncOperationOutcomeSchema.safeParse({
        kind: "conflict",
        operationId: id("01"),
        code: "SYNC_RESOURCE_CONFLICT",
        // Not a sync entity kind (notes became one in ADR 0046).
        entityKind: "board",
        taskId: id("02"),
        taskRevision: 2,
      }).success,
    ).toBe(false);
    const entity = (operation: unknown) =>
      syncOperationEntity(
        syncOperationSchema.parse({ ...base, ...(operation as object) }),
      );
    expect(
      entity({ kind: "project.create", project: { id: id("10"), title: "P" } }),
    ).toEqual({ entityKind: "project", entityId: id("10") });
    expect(
      entity({
        kind: "tag.patch",
        tagId: id("11"),
        fields: { archived: true },
        baseRevision: 1,
      }),
    ).toEqual({ entityKind: "tag", entityId: id("11") });
    expect(
      entity({ kind: "subtask.delete", subtaskId: id("12"), baseRevision: 2 }),
    ).toEqual({ entityKind: "subtask", entityId: id("12") });
    expect(
      entity({
        kind: "task.move",
        taskId: id("02"),
        parentId: null,
        index: null,
        baseParentVersion: 1,
      }),
    ).toEqual({ entityKind: "task", entityId: id("02") });
    expect(
      entity({
        kind: "habit.complete",
        habitId: id("20"),
        baseRevision: 1,
        periodKey: "2026-09-25",
      }),
    ).toBeNull();
  });
});
