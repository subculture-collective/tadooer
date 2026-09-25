import { describe, expect, it } from "vitest";
import {
  automationCatalog,
  automationPreviewCommandSchema,
  counterCreateRequestSchema,
  counterDayWriteRequestSchema,
  counterHistoryQuerySchema,
  counterPatchRequestSchema,
  evaluationWriteRequestSchema,
} from "./index.ts";

// Counter and evaluation contracts (issue #64, ADR 0025).
const id = "00000000-0000-4000-8000-000000000001";

describe("counter contracts", () => {
  it("fills defaults and keeps a countdown length on countdowns only", () => {
    expect(
      counterCreateRequestSchema.parse({ id, title: " Water ", kind: "click" }),
    ).toEqual({
      id,
      title: "Water",
      kind: "click",
      icon: null,
      enabled: true,
      hidden: false,
      streak: {
        enabled: false,
        minValue: 1,
        mode: "weekdays",
        weekdays: [1, 2, 3, 4, 5],
        weeklyFrequency: 3,
      },
      countdownMs: null,
    });
    expect(
      counterCreateRequestSchema.safeParse({
        id,
        title: "Water",
        kind: "click",
        countdownMs: 60_000,
      }).success,
    ).toBe(false);
    expect(
      counterCreateRequestSchema.safeParse({
        id,
        title: "Stretch",
        kind: "repeated_countdown",
        countdownMs: 30 * 60_000,
      }).success,
    ).toBe(true);
    expect(
      counterCreateRequestSchema.safeParse({
        id,
        title: "Water",
        kind: "click",
        streak: {
          enabled: true,
          minValue: 1,
          mode: "weekdays",
          weekdays: [1, 1],
          weeklyFrequency: 3,
        },
      }).success,
    ).toBe(false);
    expect(counterPatchRequestSchema.safeParse({}).success).toBe(false);
    expect(
      counterPatchRequestSchema.safeParse({ kind: "stopwatch" }).success,
    ).toBe(false);
  });

  it("requires the day revision read and a nonzero whole-number change", () => {
    expect(
      counterDayWriteRequestSchema.safeParse({
        action: "increment",
        delta: -1,
        expectedRevision: 0,
      }).success,
    ).toBe(true);
    for (const write of [
      { action: "increment", delta: 0, expectedRevision: 0 },
      { action: "increment", delta: 1.5, expectedRevision: 0 },
      { action: "set", value: -1, expectedRevision: 0 },
      { action: "set", value: 1 },
    ])
      expect(counterDayWriteRequestSchema.safeParse(write).success).toBe(false);
    expect(
      counterHistoryQuerySchema.safeParse({
        from: "2026-09-27",
        to: "2026-09-21",
      }).success,
    ).toBe(false);
    expect(
      evaluationWriteRequestSchema.safeParse({ expectedRevision: 0 }).success,
    ).toBe(false);
    expect(
      evaluationWriteRequestSchema.safeParse({ expectedRevision: 0, energy: 4 })
        .success,
    ).toBe(false);
  });

  it("scopes assistant counter operations to the metrics scopes", () => {
    const entries = automationCatalog.filter(({ id: entry }) =>
      [
        "counters.history",
        "evaluations.list",
        "counters.mutate",
        "counters.record",
        "evaluations.write",
      ].includes(entry),
    );
    expect(entries.map(({ id: entry, scopes }) => [entry, scopes])).toEqual([
      ["counters.history", ["metrics:read"]],
      ["evaluations.list", ["metrics:read"]],
      ["counters.mutate", ["metrics:write"]],
      ["counters.record", ["metrics:write"]],
      ["evaluations.write", ["metrics:write"]],
    ]);
    expect(
      automationPreviewCommandSchema.safeParse({
        operation: "counters.record",
        input: { action: "stop", counterId: id, expectedRevision: 2 },
      }).success,
    ).toBe(true);
    expect(
      automationPreviewCommandSchema.safeParse({
        operation: "evaluations.write",
        input: { day: "2026-09-24", expectedRevision: 0 },
      }).success,
    ).toBe(false);
  });
});
