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
  ianaTimeZoneSchema,
  importTaskCandidateSchema,
  notificationPreferencesSchema,
  notificationStatusResponseSchema,
  plannerWindowSchema,
  activeSessionCommandSchema,
  activeSessionSchema,
  automationCatalog,
  automationConfirmRequestSchema,
  automationFocusCommandInputSchema,
  automationPreviewCommandSchema,
  automationTokenSchema,
  automationTokenSecretSchema,
  createAutomationTokenRequestSchema,
  clientAuthenticationHeadersSchema,
  clientRegistrationRequestSchema,
  projectSchema,
  syncDiagnosticManifestSchema,
  syncOperationSchema,
  habitCommandSchema,
  syncRoundResponseSchema,
  syncRoundRequestSchema,
  syncTaskSnapshotSchema,
  tagSchema,
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

describe("Habit protocol", () => {
  it("rejects empty edits, mutable occurrences, and absent protocol version", () => {
    const habitId = "00000000-0000-4000-8000-000000000001";
    expect(
      habitCommandSchema.safeParse({
        kind: "habit.patch",
        habitId,
        baseRevision: 1,
        fields: {},
      }).success,
    ).toBe(false);
    for (const kind of ["habit_occurrence.patch", "habit_occurrence.delete"])
      expect(habitCommandSchema.safeParse({ kind, habitId }).success).toBe(
        false,
      );
    expect(
      syncRoundResponseSchema.safeParse({
        outcomes: [],
        changes: [],
        nextCursor: "cursor",
        hasMore: false,
        serverTimestamp: "2026-09-19T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});

describe("deadline sync contracts", () => {
  it("accepts date, instant, and clearing deadlines but rejects planned-start writes", () => {
    const base = {
      operationId: "00000000-0000-4000-8000-000000000001",
      clientSequence: 1,
      createdAt: "2026-09-19T12:00:00.000Z",
      requestHash: "a".repeat(43),
    };
    for (const deadline of [
      null,
      { kind: "date", value: "2026-09-20" },
      { kind: "instant", value: base.createdAt },
    ]) {
      expect(
        syncOperationSchema.safeParse({
          ...base,
          kind: "task.create",
          task: {
            id: base.operationId,
            title: "Task",
            notes: "",
            estimateMinutes: null,
            deadline,
          },
        }).success,
      ).toBe(true);
      expect(
        syncOperationSchema.safeParse({
          ...base,
          kind: "task.patch",
          taskId: base.operationId,
          fields: { deadline },
          baseFieldVersions: { deadline: 1 },
        }).success,
      ).toBe(true);
    }
    expect(
      syncOperationSchema.safeParse({
        ...base,
        kind: "task.patch",
        taskId: base.operationId,
        fields: { plannedStart: base.createdAt },
        baseFieldVersions: { plannedStart: 1 },
      }).success,
    ).toBe(false);
    expect(
      syncOperationSchema.safeParse({
        ...base,
        kind: "task.create",
        task: {
          id: base.operationId,
          title: "Task",
          notes: "",
          estimateMinutes: null,
          plannedStart: base.createdAt,
        },
      }).success,
    ).toBe(false);
  });
});

describe("Suite contracts", () => {
  it("keeps notification preferences and delivery health strict and content-free", () => {
    expect(
      notificationPreferencesSchema.parse({
        enabled: true,
        leadReminderEnabled: true,
        atStartReminderEnabled: true,
        detailedContentEnabled: true,
      }),
    ).toBeDefined();
    const status = {
      configured: true,
      enabled: true,
      state: "ready",
      pendingCount: 1,
      failedCount: 0,
      lastDelivery: {
        state: "delivered",
        kind: "lead",
        occurredAt: "2026-08-10T15:45:00.000Z",
        errorCode: null,
      },
    } as const;
    expect(notificationStatusResponseSchema.parse(status)).toEqual(status);
    expect(
      notificationStatusResponseSchema.safeParse({
        ...status,
        token: "publisher-secret",
      }).success,
    ).toBe(false);
    expect(
      notificationStatusResponseSchema.safeParse({
        ...status,
        lastDelivery: { ...status.lastDelivery, message: "Private task" },
      }).success,
    ).toBe(false);
  });

  it("accepts supported IANA time zones and rejects invented zones", () => {
    expect(ianaTimeZoneSchema.parse("America/Chicago")).toBe("America/Chicago");
    expect(ianaTimeZoneSchema.parse("UTC")).toBe("UTC");
    expect(ianaTimeZoneSchema.safeParse("Central-ish/Nowhere").success).toBe(
      false,
    );
  });
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

  it("accepts registered-client proofs and bounded Phase 2 task sync", () => {
    expect(
      clientRegistrationRequestSchema.parse({ label: "Firefox on Framework" }),
    ).toEqual({ label: "Firefox on Framework" });
    expect(
      clientAuthenticationHeadersSchema.parse({
        clientId: id,
        clientCredential: "A".repeat(43),
      }),
    ).toBeDefined();
    expect(
      syncRoundRequestSchema.parse(fixture("sync-round.valid.json")),
    ).toBeDefined();
    expect(
      syncOperationSchema.parse({
        operationId: id,
        clientSequence: 2,
        createdAt: "2026-08-06T16:00:00.000Z",
        requestHash: "A".repeat(43),
        kind: "task.patch",
        taskId: "1b34cc57-972c-42e8-bafa-0ba455dced20",
        fields: { title: "Merged title", notes: "Merged notes" },
        baseFieldVersions: { title: 2, notes: 4 },
      }),
    ).toBeDefined();
  });

  it("rejects sync operations that could silently overwrite or duplicate", () => {
    expect(
      syncOperationSchema.safeParse({
        operationId: id,
        clientSequence: 2,
        createdAt: "2026-08-06T16:00:00.000Z",
        requestHash: "A".repeat(43),
        kind: "task.patch",
        taskId: "1b34cc57-972c-42e8-bafa-0ba455dced20",
        fields: { title: "Merged title" },
        baseFieldVersions: { notes: 4 },
      }).success,
    ).toBe(false);
    expect(
      syncRoundRequestSchema.safeParse({
        cursor: null,
        operations: [
          {
            operationId: id,
            clientSequence: 1,
            createdAt: "2026-08-06T16:00:00.000Z",
            requestHash: "A".repeat(43),
            kind: "task.create",
            task: {
              id: "1b34cc57-972c-42e8-bafa-0ba455dced20",
              title: "Offline capture",
              notes: "",
              estimateMinutes: null,
            },
          },
          {
            operationId: id,
            clientSequence: 2,
            createdAt: "2026-08-06T16:00:01.000Z",
            requestHash: "B".repeat(43),
            kind: "task.create",
            task: {
              id: "728a504a-0997-4eb3-94dd-5d6ff8af5967",
              title: "Second capture",
              notes: "",
              estimateMinutes: null,
            },
          },
        ],
        pullLimit: 100,
      }).success,
    ).toBe(false);
    expect(
      clientAuthenticationHeadersSchema.safeParse({
        clientId: id,
        clientCredential: "short",
      }).success,
    ).toBe(false);
  });

  it("models project, tag, and local cache task state without duplicate tags", () => {
    expect(
      projectSchema.parse({
        id,
        ownerId: "1b34cc57-972c-42e8-bafa-0ba455dced20",
        title: "Home",
        revision: 1,
        createdAt: "2026-08-06T16:00:00.000Z",
        updatedAt: "2026-08-06T16:00:00.000Z",
        archivedAt: null,
      }),
    ).toBeDefined();
    expect(
      tagSchema.parse({
        id,
        ownerId: "1b34cc57-972c-42e8-bafa-0ba455dced20",
        displayName: "Errands",
        normalizedName: "errands",
        revision: 1,
        createdAt: "2026-08-06T16:00:00.000Z",
        updatedAt: "2026-08-06T16:00:00.000Z",
        archivedAt: null,
      }),
    ).toBeDefined();
    expect(
      syncTaskSnapshotSchema.safeParse({
        task: {
          id,
          title: "Tagged task",
          notes: "",
          status: "open",
          revision: 1,
          createdAt: "2026-08-06T16:00:00.000Z",
          updatedAt: "2026-08-06T16:00:00.000Z",
          projectId: null,
          tagIds: [id, id],
        },
        fieldVersions: {
          title: 1,
          notes: 1,
          status: 1,
          estimateMinutes: 1,
          projectId: 1,
          tagIds: 1,
        },
        changeSequence: 1,
      }).success,
    ).toBe(false);
  });

  it("requires a live controller lease for a running active session", () => {
    expect(
      activeSessionSchema.safeParse({
        id,
        ownerId: "1b34cc57-972c-42e8-bafa-0ba455dced20",
        taskId: "728a504a-0997-4eb3-94dd-5d6ff8af5967",
        controllerClientId: "4519c805-e478-486b-a918-616fc6d9ea98",
        state: "running",
        phase: "focus",
        revision: 1,
        startedAt: "2026-08-06T16:00:00.000Z",
        updatedAt: "2026-08-06T16:00:00.000Z",
        leaseExpiresAt: null,
        hardExpiresAt: "2026-08-07T16:00:00.000Z",
        currentIntervalId: null,
      }).success,
    ).toBe(false);
    expect(
      activeSessionCommandSchema.parse({
        command: "takeover",
        sessionId: id,
        expectedRevision: 3,
        idempotencyKey: "takeover-request-0001",
      }),
    ).toBeDefined();
    expect(
      activeSessionCommandSchema.safeParse({
        command: "start",
        taskId: id,
      }).success,
    ).toBe(false);
  });

  it("rejects recovery diagnostics that contain task content or secrets", () => {
    const validManifest = fixture(
      "sync-diagnostic-manifest.valid.json",
    ) as Record<string, unknown>;
    expect(syncDiagnosticManifestSchema.parse(validManifest)).toBeDefined();
    expect(
      syncDiagnosticManifestSchema.safeParse(
        fixture("sync-diagnostic-manifest.invalid.json"),
      ).success,
    ).toBe(false);
    expect(
      syncDiagnosticManifestSchema.safeParse({
        ...validManifest,
        clientCredential: "A".repeat(43),
      }).success,
    ).toBe(false);
  });

  it("defines scoped, opaque automation credentials without browser-client reuse", () => {
    expect(
      createAutomationTokenRequestSchema.parse({
        label: "Local planning agent",
        scopes: ["tasks:read", "tasks:write", "schedule:read"],
        expiresAt: "2026-09-01T00:00:00.000Z",
      }),
    ).toBeDefined();
    expect(
      automationTokenSecretSchema.parse(`suite_at_${id}.${"A".repeat(43)}`),
    ).toContain("suite_at_");
    expect(
      automationTokenSchema.parse({
        id,
        ownerId: "1b34cc57-972c-42e8-bafa-0ba455dced20",
        label: "Local planning agent",
        scopes: ["tasks:read", "tasks:write"],
        createdAt: "2026-08-06T16:00:00.000Z",
        lastUsedAt: null,
        expiresAt: "2026-09-01T00:00:00.000Z",
        revokedAt: null,
      }),
    ).toBeDefined();
    expect(
      createAutomationTokenRequestSchema.safeParse({
        label: "Duplicate scope",
        scopes: ["tasks:read", "tasks:read"],
        expiresAt: "2026-09-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(automationTokenSecretSchema.safeParse("A".repeat(43)).success).toBe(
      false,
    );
  });

  it("requires a typed preview and a separate idempotency-bearing confirmation", () => {
    expect(
      automationPreviewCommandSchema.parse({
        operation: "tasks.create",
        input: { title: "Prepare status", notes: "No side effect yet" },
      }),
    ).toBeDefined();
    expect(
      automationPreviewCommandSchema.parse({
        operation: "schedule.create_time_block",
        input: {
          taskId: id,
          calendarId: "1b34cc57-972c-42e8-bafa-0ba455dced20",
          startsAt: "2026-08-06T18:00:00.000Z",
          durationMinutes: 30,
        },
      }),
    ).toBeDefined();
    expect(
      automationFocusCommandInputSchema.parse({
        operation: "focus.takeover",
        sessionId: id,
        expectedRevision: 2,
      }),
    ).toBeDefined();
    expect(
      automationConfirmRequestSchema.parse({
        idempotencyKey: "automation-confirm-0001",
      }),
    ).toBeDefined();
    expect(
      automationPreviewCommandSchema.safeParse({
        operation: "focus.pause",
        input: {
          operation: "focus.resume",
          sessionId: id,
          expectedRevision: 2,
        },
      }).success,
    ).toBe(false);
    expect(
      automationConfirmRequestSchema.safeParse({ dryRun: false }).success,
    ).toBe(false);
  });

  it("keeps one catalog for Suite HTTP and MCP without legacy bridge identifiers", () => {
    const ids = automationCatalog.map((entry) => entry.id);
    const names = automationCatalog.map((entry) => entry.mcpName);
    const uris = automationCatalog.flatMap((entry) =>
      "mcpUri" in entry ? [entry.mcpUri] : [],
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(uris).size).toBe(uris.length);
    expect(automationCatalog).toHaveLength(79);
    expect(ids).toEqual(
      expect.arrayContaining([
        "tasks.update",
        "tasks.hierarchy",
        "tasks.history",
        "tasks.archive",
        "tasks.unarchive",
        "tasks.set_completed",
        "pools.list",
        "placeholders.resolve",
        "habits.list",
        "habits.mutate",
        "projects.reorder",
        "projects.set_backlog",
        "tags.reorder",
        "notes.list",
        "notes.mutate",
        "task_links.get",
        "task_links.mutate",
        "time.report",
        "time_entries.mutate",
        "counters.history",
        "evaluations.list",
        "counters.mutate",
        "counters.record",
        "evaluations.write",
        "plugin_data.list",
      ]),
    );
    for (const entry of automationCatalog) {
      expect(entry.apiPath).toMatch(/^\/api\/automation\/v1\//);
      expect(entry.mcpName.startsWith("suite.")).toBe(true);
      expect("mcpUri" in entry ? entry.mcpUri.startsWith("sp://") : false).toBe(
        false,
      );
      expect(entry.scopes.length).toBeGreaterThan(0);
      if (entry.kind === "tool" && entry.id !== "automation.confirm")
        expect(entry.confirmationRequired).toBe(true);
      else expect(entry.confirmationRequired).toBe(false);
    }
  });
});
