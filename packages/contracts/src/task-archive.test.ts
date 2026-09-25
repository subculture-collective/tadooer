import { expect, it } from "vitest";
import {
  automationCatalog,
  automationPreviewCommandSchema,
  superProductivityPreviewSchema,
  taskHistoryQuerySchema,
  taskHistoryResponseSchema,
} from "./index.ts";

const id = "00000000-0000-4000-8000-000000000001";

it("declares history reads and archive writes in the single catalog", () => {
  const entries = new Map(automationCatalog.map((entry) => [entry.id, entry]));
  expect(entries.get("tasks.history")).toMatchObject({
    kind: "resource",
    scopes: ["tasks:read"],
    apiPath: "/api/automation/v1/resources/tasks/history",
    mcpUri: "suite://v1/tasks/history{?query,cursor,limit}",
  });
  for (const operation of ["tasks.archive", "tasks.unarchive"] as const) {
    expect(entries.get(operation)).toMatchObject({
      kind: "tool",
      scopes: ["tasks:write"],
      confirmationRequired: true,
    });
    expect(
      automationPreviewCommandSchema.safeParse({
        operation,
        input: { taskId: id, expectedRevision: 2 },
      }).success,
    ).toBe(true);
    expect(
      automationPreviewCommandSchema.safeParse({
        operation,
        input: { taskId: id },
      }).success,
    ).toBe(false);
  }
});

it("bounds history queries and validates history pages", () => {
  expect(taskHistoryQuerySchema.parse({ limit: "25" })).toEqual({ limit: 25 });
  for (const invalid of [
    { limit: "0" },
    { limit: "201" },
    { cursor: "has spaces" },
    { query: "x".repeat(201) },
    { unknown: "1" },
  ])
    expect(taskHistoryQuerySchema.safeParse(invalid).success).toBe(false);
  const task = {
    id,
    title: "Archived",
    notes: "",
    status: "completed",
    revision: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    archivedAt: "2026-09-24T00:00:00.000Z",
  };
  expect(
    taskHistoryResponseSchema.safeParse({
      entries: [
        {
          task,
          provenance: {
            source: "super_productivity",
            sourceStore: "archiveOld",
            review: ["blank_title"],
            historicalReferences: [
              { kind: "project", sourceId: "p", reason: "missing_from_export" },
            ],
          },
          children: [],
        },
      ],
      total: 1,
      nextCursor: null,
    }).success,
  ).toBe(true);
  expect(
    taskHistoryResponseSchema.safeParse({
      entries: [{ task, provenance: null, children: [], extra: true }],
      total: 1,
      nextCursor: null,
    }).success,
  ).toBe(false);
});

it("accepts the preview's history dispositions without requiring them", () => {
  const base = {
    source: "super_productivity",
    inputHash: "a".repeat(64),
    canApply: true,
    totals: {
      tasks: 0,
      completed: 0,
      archived: 0,
      childTasks: 0,
      projects: 0,
      tags: 0,
      repeatConfigurations: 0,
      trackedMilliseconds: 0,
    },
    tasks: [],
    issues: [{ code: "history_review", sourceId: "x", detail: "d" }],
  };
  expect(superProductivityPreviewSchema.safeParse(base).success).toBe(true);
  expect(
    superProductivityPreviewSchema.safeParse({
      ...base,
      issues: [{ ...base.issues[0], blocking: false }],
    }).success,
  ).toBe(true);
});
