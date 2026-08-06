import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  apiErrorSchema,
  calendarEventIdentitySchema,
  createTaskRequestSchema,
  idempotencyKeySchema,
  importTaskCandidateSchema,
  taskSchema,
} from "./index.ts";

const id = "d1054acd-c04d-4bd8-a814-254b007154ba";

describe("Phase 0 contracts", () => {
  it("accepts stable task and calendar-event identities", () => {
    expect(
      taskSchema.parse({
        id,
        title: "Capture the first task",
        notes: "",
        status: "open",
        revision: 1,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedAt: "2026-08-05T00:00:00.000Z",
      }),
    ).toMatchObject({ id, revision: 1 });
    expect(
      calendarEventIdentitySchema.parse({
        providerId: id,
        calendarId: "1b34cc57-972c-42e8-bafa-0ba455dced20",
        eventId: "https://calendar.example/events/one.ics",
      }),
    ).toBeDefined();
  });

  it("rejects malformed identities, revisions, inputs, and idempotency keys", () => {
    expect(
      taskSchema.safeParse({
        id: "task-1",
        title: "",
        notes: "",
        status: "open",
        revision: 0,
        createdAt: "yesterday",
        updatedAt: "today",
      }).success,
    ).toBe(false);
    expect(
      calendarEventIdentitySchema.safeParse({
        providerId: id,
        calendarId: "not-a-uuid",
        eventId: "",
      }).success,
    ).toBe(false);
    expect(createTaskRequestSchema.safeParse({ title: "   " }).success).toBe(
      false,
    );
    expect(idempotencyKeySchema.safeParse("short").success).toBe(false);
  });

  it("requires a bounded machine code and traceable request id for errors", () => {
    expect(
      apiErrorSchema.safeParse({
        code: "INVALID_TASK",
        message: "Task input is invalid",
        requestId: id,
      }).success,
    ).toBe(true);
    expect(
      apiErrorSchema.safeParse({
        code: "invalid task",
        message: "Task input is invalid",
      }).success,
    ).toBe(false);
  });

  it("accepts valid import candidates and rejects invalid fixture data", () => {
    const fixture = (name: string): unknown =>
      JSON.parse(
        readFileSync(
          new URL(`../test-fixtures/${name}`, import.meta.url),
          "utf8",
        ),
      ) as unknown;
    expect(
      importTaskCandidateSchema.safeParse(fixture("task-import.valid.json"))
        .success,
    ).toBe(true);
    expect(
      importTaskCandidateSchema.safeParse(fixture("task-import.invalid.json"))
        .success,
    ).toBe(false);
  });
});
