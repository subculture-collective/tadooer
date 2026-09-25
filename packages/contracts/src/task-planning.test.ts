import { describe, expect, it } from "vitest";
import {
  automationTaskUpdateInputSchema,
  createTaskRequestSchema,
  syncOperationSchema,
  taskPatchRequestSchema,
  taskSchema,
} from "./index.ts";

describe("date-only planning and reminder contracts", () => {
  it("accepts planned days and source reminder offsets only", () => {
    expect(
      taskPatchRequestSchema.safeParse({
        plannedDay: "2026-03-08",
        startReminder: { kind: "before_start", minutes: 30 },
        deadlineReminder: { minutes: 60 },
      }).success,
    ).toBe(true);
    for (const invalid of [
      { plannedDay: "2026-02-30" },
      { plannedDay: "2026-03-08T00:00:00.000Z" },
      { startReminder: { kind: "before_start", minutes: 7 } },
      { startReminder: { kind: "before_start" } },
      { deadlineReminder: { minutes: 45 } },
    ])
      expect(taskPatchRequestSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects a planned day together with an exact start", () => {
    expect(
      taskPatchRequestSchema.safeParse({
        plannedDay: "2026-03-08",
        plannedStart: "2026-03-08T15:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      taskPatchRequestSchema.safeParse({
        plannedDay: "2026-03-08",
        plannedStart: null,
      }).success,
    ).toBe(true);
    expect(
      automationTaskUpdateInputSchema.safeParse({
        taskId: "00000000-0000-4000-8000-000000000001",
        expectedRevision: 1,
        patch: {
          plannedDay: "2026-03-08",
          plannedStart: "2026-03-08T15:00:00.000Z",
        },
      }).success,
    ).toBe(false);
  });

  it("keeps planning fields optional in task snapshots and out of offline sync", () => {
    const task = {
      id: "00000000-0000-4000-8000-000000000001",
      title: "Task",
      notes: "",
      status: "open",
      revision: 1,
      createdAt: "2026-09-24T12:00:00.000Z",
      updatedAt: "2026-09-24T12:00:00.000Z",
    };
    expect(taskSchema.parse(task)).not.toHaveProperty("plannedDay");
    expect(
      taskSchema.parse({
        ...task,
        plannedDay: "2026-09-24",
        startReminder: { kind: "none" },
      }),
    ).toMatchObject({ plannedDay: "2026-09-24" });
    expect(
      createTaskRequestSchema.parse({
        title: "Task",
        plannedDay: "2026-09-24",
      }),
    ).toMatchObject({ plannedDay: "2026-09-24" });
    expect(
      syncOperationSchema.safeParse({
        operationId: "00000000-0000-4000-8000-000000000002",
        clientSequence: 1,
        createdAt: "2026-09-24T12:00:00.000Z",
        requestHash: "a".repeat(43),
        kind: "task.patch",
        taskId: task.id,
        fields: { plannedDay: "2026-09-24" },
        baseFieldVersions: { plannedDay: 1 },
      }).success,
    ).toBe(false);
  });
});
