import { describe, expect, it } from "vitest";
import {
  automationCatalog,
  automationPreviewCommandSchema,
  timeEntryCreateRequestSchema,
  timeEntryPatchRequestSchema,
  timeReportQuerySchema,
} from "./index.ts";

// Work history contracts (issue #41, ADR 0024).
const id = "00000000-0000-4000-8000-000000000001";

describe("time history contracts", () => {
  it("accepts nonzero whole-millisecond entries within one day", () => {
    const entry = {
      id,
      taskId: id,
      workDate: "2026-09-24",
      durationMs: -300_000,
    };
    expect(timeEntryCreateRequestSchema.parse(entry)).toEqual({
      ...entry,
      note: "",
    });
    for (const durationMs of [0, 1.5, 86_400_001, -86_400_001])
      expect(
        timeEntryCreateRequestSchema.safeParse({ ...entry, durationMs })
          .success,
      ).toBe(false);
    expect(
      timeEntryCreateRequestSchema.safeParse({
        ...entry,
        workDate: "2026-02-30",
      }).success,
    ).toBe(false);
    expect(timeEntryPatchRequestSchema.safeParse({}).success).toBe(false);
    expect(
      timeEntryPatchRequestSchema.safeParse({ source: "focus" }).success,
    ).toBe(false);
  });

  it("bounds report ranges to 366 ordered days", () => {
    expect(
      timeReportQuerySchema.safeParse({ from: "2026-01-01", to: "2027-01-01" })
        .success,
    ).toBe(true);
    expect(
      timeReportQuerySchema.safeParse({ from: "2026-01-01", to: "2027-01-02" })
        .success,
    ).toBe(false);
    expect(
      timeReportQuerySchema.safeParse({ from: "2026-09-02", to: "2026-09-01" })
        .success,
    ).toBe(false);
  });

  it("exposes the worklog to tasks:read and corrections to tasks:write with confirmation", () => {
    const entries = new Map<string, unknown>(
      automationCatalog.map((entry) => [entry.id, entry]),
    );
    expect(entries.get("time.report")).toMatchObject({
      kind: "resource",
      scopes: ["tasks:read"],
      mcpUri: "suite://v1/time-report{?from,to}",
    });
    expect(entries.get("time_entries.mutate")).toMatchObject({
      kind: "tool",
      scopes: ["tasks:write"],
      confirmationRequired: true,
    });
    expect(
      automationPreviewCommandSchema.safeParse({
        operation: "time_entries.mutate",
        input: { action: "delete", id, expectedRevision: 1 },
      }).success,
    ).toBe(true);
    expect(
      automationPreviewCommandSchema.safeParse({
        operation: "time_entries.mutate",
        input: { action: "delete", id },
      }).success,
    ).toBe(false);
  });
});
