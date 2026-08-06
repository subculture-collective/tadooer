import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  apiErrorSchema,
  calendarEventConflictSchema,
  calendarEventIdentitySchema,
  calendarEventProjectionSchema,
  conditionalRequestHeadersSchema,
  createTaskRequestSchema,
  createTaskTimeBlockRequestSchema,
  idempotencyKeySchema,
  importTaskCandidateSchema,
  plannerWindowSchema,
  taskEventMappingSchema,
  taskPatchRequestSchema,
  taskRestoreRequestSchema,
  taskSchema,
} from "./index.ts";

const id = "d1054acd-c04d-4bd8-a814-254b007154ba";

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../test-fixtures/${name}`, import.meta.url), "utf8"),
  ) as unknown;

describe("Suite contracts", () => {
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
    expect(
      importTaskCandidateSchema.safeParse(fixture("task-import.valid.json"))
        .success,
    ).toBe(true);
    expect(
      importTaskCandidateSchema.safeParse(fixture("task-import.invalid.json"))
        .success,
    ).toBe(false);
  });

  it("accepts bounded Phase 1 planner, patch, and time-block contracts", () => {
    expect(
      plannerWindowSchema.parse({
        from: "2026-08-06T00:00:00.000Z",
        to: "2026-08-13T00:00:00.000Z",
      }),
    ).toBeDefined();
    expect(
      taskPatchRequestSchema.parse({
        title: "Rename task",
        estimateMinutes: 45,
        plannedStart: "2026-08-06T15:00:00.000Z",
      }),
    ).toBeDefined();
    expect(conditionalRequestHeadersSchema.parse({ ifMatch: '"2"' })).toEqual({
      ifMatch: '"2"',
    });
    expect(taskRestoreRequestSchema.parse({})).toEqual({});
    expect(
      createTaskTimeBlockRequestSchema.parse({
        calendarId: id,
        startsAt: "2026-08-06T15:00:00.000Z",
        durationMinutes: 45,
      }),
    ).toBeDefined();
  });

  it("accepts only non-recurring timed event projections and qualified mappings", () => {
    const event = calendarEventProjectionSchema.parse(
      fixture("calendar-event-projection.valid.json"),
    );
    expect(event.recurrence).toBe("none");
    expect(
      calendarEventProjectionSchema.safeParse(
        fixture("calendar-event-projection.invalid.json"),
      ).success,
    ).toBe(false);
    expect(
      taskEventMappingSchema.parse({
        id,
        taskId: "1b34cc57-972c-42e8-bafa-0ba455dced20",
        event: event.identity,
        href: event.href,
        uid: event.uid,
        etag: event.etag,
        state: "active",
        createdBySuite: true,
        createdAt: "2026-08-06T15:00:00.000Z",
        updatedAt: "2026-08-06T15:00:00.000Z",
      }),
    ).toBeDefined();
  });

  it("rejects unsafe lifecycle preconditions and bounded planner inputs", () => {
    expect(
      conditionalRequestHeadersSchema.safeParse({ ifMatch: "2" }).success,
    ).toBe(false);
    expect(taskPatchRequestSchema.safeParse({}).success).toBe(false);
    expect(taskRestoreRequestSchema.safeParse({ status: "open" }).success).toBe(
      false,
    );
    expect(
      taskPatchRequestSchema.safeParse({ estimateMinutes: 0 }).success,
    ).toBe(false);
    expect(
      plannerWindowSchema.safeParse({
        from: "2026-08-06T00:00:00.000Z",
        to: "2026-09-07T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      createTaskTimeBlockRequestSchema.safeParse({
        calendarId: id,
        startsAt: "2026-08-06T15:00:00.000Z",
        durationMinutes: 721,
      }).success,
    ).toBe(false);
  });

  it("keeps calendar conflicts safe and actionable", () => {
    expect(
      calendarEventConflictSchema.parse({
        code: "CALENDAR_EVENT_CONFLICT",
        message: "The calendar event changed and needs a refresh",
        requestId: id,
        action: "refresh_and_replan",
        mappingId: null,
      }),
    ).toBeDefined();
    expect(
      calendarEventConflictSchema.safeParse({
        code: "CALENDAR_EVENT_CONFLICT",
        message: "Raw event content must not be exposed",
        requestId: id,
        action: "overwrite",
        mappingId: null,
      }).success,
    ).toBe(false);
  });
});
