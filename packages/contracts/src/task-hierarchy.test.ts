import { expect, it } from "vitest";
import {
  automationPreviewCommandSchema,
  syncDiagnosticOperationSchema,
  syncOperationSchema,
  taskChildOrderRequestSchema,
  taskMoveRequestSchema,
} from "./index.ts";

const id = (tail: string) => `00000000-0000-4000-8000-0000000000${tail}`;

it("validates task.move sync operations and hierarchy request bodies", () => {
  const move = {
    kind: "task.move",
    operationId: id("01"),
    clientSequence: 1,
    createdAt: "2026-09-24T00:00:00.000Z",
    requestHash: "a".repeat(43),
    taskId: id("02"),
    parentId: id("03"),
    index: 0,
    baseParentVersion: 1,
  };
  expect(syncOperationSchema.safeParse(move).success).toBe(true);
  expect(
    syncOperationSchema.safeParse({ ...move, parentId: null, index: null })
      .success,
  ).toBe(true);
  expect(
    syncOperationSchema.safeParse({ ...move, baseParentVersion: 0 }).success,
  ).toBe(false);
  expect(
    syncDiagnosticOperationSchema.shape.kind.safeParse("task.move").success,
  ).toBe(true);
  expect(
    taskMoveRequestSchema.safeParse({ parentId: null, extra: 1 }).success,
  ).toBe(false);
  expect(
    taskChildOrderRequestSchema.safeParse({
      items: [
        { id: id("04"), revision: 1 },
        { id: id("04"), revision: 2 },
      ],
    }).success,
  ).toBe(false);
});

it("accepts only complete assistant hierarchy commands", () => {
  const parse = (input: unknown) =>
    automationPreviewCommandSchema.safeParse({
      operation: "tasks.hierarchy",
      input,
    }).success;
  expect(
    parse({
      action: "create_child",
      parentId: id("01"),
      expectedParentRevision: 1,
      task: { title: "Child" },
    }),
  ).toBe(true);
  expect(
    parse({
      action: "create_child",
      parentId: id("01"),
      expectedParentRevision: 1,
      task: { title: "Child", structured: true },
    }),
  ).toBe(false);
  expect(
    parse({
      action: "move",
      taskId: id("02"),
      expectedRevision: 3,
      parentId: null,
    }),
  ).toBe(true);
  expect(parse({ action: "move", taskId: id("02"), parentId: null })).toBe(
    false,
  );
  expect(
    parse({
      action: "reorder",
      parentId: id("01"),
      expectedParentRevision: 1,
      items: [{ id: id("02"), revision: 1 }],
    }),
  ).toBe(true);
});
