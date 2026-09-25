import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import { SuiteDatabase } from "./index.ts";

// Work history storage (issue #41, ADR 0024).
const zone = "America/Chicago";
const now = "2026-09-24T17:00:00.000Z";
const ids = {
  task: "00000000-0000-4000-8000-000000000001",
  parent: "00000000-0000-4000-8000-000000000002",
  child: "00000000-0000-4000-8000-000000000003",
  entry: "10000000-0000-4000-8000-000000000001",
  second: "10000000-0000-4000-8000-000000000002",
  third: "10000000-0000-4000-8000-000000000003",
  interval: "20000000-0000-4000-8000-000000000001",
  running: "20000000-0000-4000-8000-000000000002",
};
const minutes = (value: number) => value * 60_000;

const open = (directory: string) => {
  const db = SuiteDatabase.open(join(directory, "suite.sqlite"));
  db.createOwner({
    id: "owner",
    username: "owner",
    displayName: "Owner",
    passwordHash: "hash",
    createdAt: now,
  });
  db.registerSyncClient({
    id: "client",
    ownerId: "owner",
    label: "Laptop",
    credentialHash: "credential",
    createdAt: now,
    lastSeenAt: now,
    revokedAt: null,
  });
  return db;
};

const task = (
  db: SuiteDatabase,
  id: string,
  title: string,
  estimate: number | null = null,
) => {
  const result = db.createTaskIdempotently("owner", `create-${id}`, id, {
    id,
    title,
    notes: "",
    status: "open",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    estimateMinutes: estimate,
  });
  if (result.kind !== "created") throw new Error("Task was not created");
};

/** A focus session with one interval; `endedAt: null` keeps it running. */
const focus = (
  db: SuiteDatabase,
  input: {
    readonly sessionId: string;
    readonly intervalId: string;
    readonly taskId: string;
    readonly startedAt: string;
    readonly endedAt: string | null;
    readonly leaseExpiresAt?: string;
  },
) => {
  const running = input.endedAt === null;
  const result = db.applyActiveSessionTransition({
    session: {
      id: input.sessionId,
      ownerId: "owner",
      taskId: input.taskId,
      controllerClientId: "client",
      state: running ? "running" : "completed",
      phase: "focus",
      revision: 1,
      startedAt: input.startedAt,
      leaseExpiresAt: running
        ? (input.leaseExpiresAt ?? "2026-09-25T00:00:00.000Z")
        : null,
      hardExpiresAt: "2026-09-26T00:00:00.000Z",
      createdAt: input.startedAt,
      updatedAt: input.startedAt,
      endedAt: input.endedAt,
    },
    expectedRevision: null,
    clientId: "client",
    idempotencyKey: `start-${input.sessionId}`,
    requestHash: `hash-${input.sessionId}`,
    events: [],
    intervals: [
      {
        id: input.intervalId,
        ordinal: 1,
        phase: "focus",
        taskId: input.taskId,
        controllerClientId: "client",
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        closedBy: running ? null : "complete",
      },
    ],
    now: input.startedAt,
  });
  if (result.kind !== "applied") throw new Error("Session was not stored");
};

const add = (
  db: SuiteDatabase,
  id: string,
  durationMs: number,
  workDate = "2026-09-24",
  taskId = ids.task,
) =>
  db.timeEntries.create({
    ownerId: "owner",
    id,
    taskId,
    workDate,
    durationMs,
    note: "",
    timeZone: zone,
    now,
  });

it("adds, replays, edits and deletes manual entries with revisions", async () => {
  await withTemporaryDirectory((directory) => {
    const db = open(directory);
    task(db, ids.task, "Write report");
    const created = add(db, ids.entry, minutes(45));
    expect(created).toMatchObject({
      kind: "applied",
      dayTotalMs: minutes(45),
      entry: { revision: 1, source: "manual", durationMs: minutes(45) },
    });
    // A retry with the same ID and content replays; different content does not.
    expect(add(db, ids.entry, minutes(45))).toMatchObject({ kind: "replayed" });
    expect(add(db, ids.entry, minutes(50))).toEqual({ kind: "exists" });

    const edit = (expectedRevision: number, durationMs: number) =>
      db.timeEntries.update({
        ownerId: "owner",
        id: ids.entry,
        expectedRevision,
        patch: { durationMs, note: "Drafting" },
        timeZone: zone,
        now,
      });
    expect(edit(1, minutes(30))).toMatchObject({
      kind: "applied",
      entry: { revision: 2, durationMs: minutes(30), note: "Drafting" },
    });
    // A concurrent correction against the old revision is stale.
    expect(edit(1, minutes(20))).toMatchObject({
      kind: "precondition-failed",
      entry: { revision: 2 },
    });
    expect(
      db.timeEntries.delete({
        ownerId: "owner",
        id: ids.entry,
        expectedRevision: 1,
        timeZone: zone,
        now,
      }).kind,
    ).toBe("precondition-failed");
    expect(
      db.timeEntries.delete({
        ownerId: "owner",
        id: ids.entry,
        expectedRevision: 2,
        timeZone: zone,
        now,
      }),
    ).toMatchObject({ kind: "applied", deletedId: ids.entry, dayTotalMs: 0 });
    expect(db.timeEntries.get("owner", ids.entry)).toBeUndefined();
    db.close();
  });
});

it("sums manual entries with overlapping focus time and bounds the task-day total", async () => {
  await withTemporaryDirectory((directory) => {
    const db = open(directory);
    task(db, ids.task, "Write report", 120);
    focus(db, {
      sessionId: "30000000-0000-4000-8000-000000000001",
      intervalId: ids.interval,
      taskId: ids.task,
      startedAt: "2026-09-24T14:00:00.000Z",
      endedAt: "2026-09-24T15:00:00.000Z",
    });
    // Manual time for the same task and day adds to focus; daily totals have
    // no time of day, so they cannot be checked for interval overlap.
    expect(add(db, ids.entry, minutes(30))).toMatchObject({
      kind: "applied",
      dayTotalMs: minutes(90),
    });
    // A correction may lower focus time but never below zero.
    expect(add(db, ids.second, -minutes(100))).toEqual({
      kind: "invalid",
      code: "day_total_negative",
    });
    expect(add(db, ids.second, -minutes(10))).toMatchObject({
      kind: "applied",
      dayTotalMs: minutes(80),
    });
    // A task-day total never exceeds 24 hours.
    expect(add(db, ids.third, 86_400_000 - minutes(79))).toEqual({
      kind: "invalid",
      code: "day_total_exceeds_day",
    });
    const report = db.timeEntries.report({
      ownerId: "owner",
      from: "2026-09-24",
      to: "2026-09-24",
      timeZone: zone,
      now,
    });
    expect(report.totalMs).toBe(minutes(80));
    expect(report.bySource).toEqual({
      focus: minutes(60),
      import: 0,
      manual: minutes(20),
    });
    expect(report.days).toEqual([
      expect.objectContaining({
        date: "2026-09-24",
        totalMs: minutes(80),
        tasks: [
          {
            taskId: ids.task,
            totalMs: minutes(80),
            bySource: { focus: minutes(60), import: 0, manual: minutes(20) },
          },
        ],
      }),
    ]);
    expect(report.tasks).toEqual([
      expect.objectContaining({
        taskId: ids.task,
        ownMs: minutes(80),
        childrenMs: 0,
        allTimeMs: minutes(80),
        estimateMinutes: 120,
      }),
    ]);
    expect(report.entries.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([ids.interval, ids.entry, ids.second]),
    );
    db.close();
  });
});

it("keeps focus entries read-only and refuses to lower a day while focus runs", async () => {
  await withTemporaryDirectory((directory) => {
    const db = open(directory);
    task(db, ids.task, "Write report");
    focus(db, {
      sessionId: "30000000-0000-4000-8000-000000000002",
      intervalId: ids.running,
      taskId: ids.task,
      startedAt: "2026-09-24T16:30:00.000Z",
      endedAt: null,
    });
    // The running interval counts up to now.
    expect(
      db.timeEntries.dayTotal("owner", ids.task, "2026-09-24", zone, now),
    ).toEqual({ totalMs: minutes(30), focusRunning: true });
    expect(
      db.timeEntries.update({
        ownerId: "owner",
        id: ids.running,
        expectedRevision: 1,
        patch: { durationMs: minutes(5) },
        timeZone: zone,
        now,
      }),
    ).toEqual({ kind: "invalid", code: "entry_read_only" });
    expect(
      db.timeEntries.delete({
        ownerId: "owner",
        id: ids.running,
        expectedRevision: 1,
        timeZone: zone,
        now,
      }),
    ).toEqual({ kind: "invalid", code: "entry_read_only" });
    expect(add(db, ids.entry, -minutes(5))).toEqual({
      kind: "invalid",
      code: "focus_running",
    });
    // Adding time is allowed while focus runs; lowering it is not.
    expect(add(db, ids.entry, minutes(15)).kind).toBe("applied");
    expect(
      db.timeEntries.delete({
        ownerId: "owner",
        id: ids.entry,
        expectedRevision: 1,
        timeZone: zone,
        now,
      }),
    ).toEqual({ kind: "invalid", code: "focus_running" });
    // Another day is not affected by the running interval.
    expect(add(db, ids.second, minutes(10), "2026-09-23").kind).toBe("applied");
    expect(
      db.timeEntries.delete({
        ownerId: "owner",
        id: ids.second,
        expectedRevision: 1,
        timeZone: zone,
        now,
      }).kind,
    ).toBe("applied");
    const report = db.timeEntries.report({
      ownerId: "owner",
      from: "2026-09-24",
      to: "2026-09-24",
      timeZone: zone,
      now,
    });
    expect(
      report.entries.find((entry) => entry.id === ids.running),
    ).toMatchObject({ running: true, durationMs: minutes(30) });
    // After the lease boundary the open interval stops counting.
    expect(
      db.timeEntries.dayTotal(
        "owner",
        ids.task,
        "2026-09-24",
        zone,
        "2026-09-25T06:00:00.000Z",
      ).focusRunning,
    ).toBe(false);
    db.close();
  });
});

it("assigns focus time to Chicago days across the daylight-saving change", async () => {
  await withTemporaryDirectory((directory) => {
    const db = open(directory);
    task(db, ids.task, "Night shift");
    // 23:30 CDT on October 31 to 01:30 CST on November 1 (three hours).
    focus(db, {
      sessionId: "30000000-0000-4000-8000-000000000003",
      intervalId: ids.interval,
      taskId: ids.task,
      startedAt: "2026-11-01T04:30:00.000Z",
      endedAt: "2026-11-01T07:30:00.000Z",
    });
    const report = db.timeEntries.report({
      ownerId: "owner",
      from: "2026-10-31",
      to: "2026-11-01",
      timeZone: zone,
      now: "2026-11-02T00:00:00.000Z",
    });
    expect(report.days.map(({ date, totalMs }) => [date, totalMs])).toEqual([
      ["2026-10-31", minutes(30)],
      ["2026-11-01", minutes(150)],
    ]);
    // October 31 is a Saturday and November 1 a Sunday of the same week.
    expect(report.weeks).toEqual([
      { weekStart: "2026-10-26", totalMs: minutes(180), daysWorked: 2 },
    ]);
    // A one-day report of November 1 holds only that day's part.
    expect(
      db.timeEntries.report({
        ownerId: "owner",
        from: "2026-11-01",
        to: "2026-11-01",
        timeZone: zone,
        now: "2026-11-02T00:00:00.000Z",
      }).totalMs,
    ).toBe(minutes(150));
    db.close();
  });
});

it("imports daily history once, keeps archived time read-only and survives backup and restore", async () => {
  await withTemporaryDirectory((directory) => {
    const db = open(directory);
    const records = [
      {
        kind: "project" as const,
        sourceId: "p1",
        sourceHash: "p1",
        sourceJson: "{}",
        title: "Client work",
        notes: "",
        projectId: null,
        tagIds: [],
        plannedStart: null,
        deadlineDate: null,
        deadlineAt: null,
        estimateMinutes: null,
        completedAt: null,
        createdAt: now,
      },
      ...(["parent", "child"] as const).map((sourceId) => ({
        kind: "task" as const,
        sourceId,
        sourceHash: sourceId,
        sourceJson: "{}",
        title: sourceId === "parent" ? "Quarterly report" : "Collect numbers",
        notes: "",
        projectId: "p1",
        tagIds: [],
        plannedStart: null,
        deadlineDate: null,
        deadlineAt: null,
        estimateMinutes: sourceId === "child" ? 60 : null,
        completedAt: now,
        createdAt: now,
        parentSourceId: sourceId === "child" ? "parent" : null,
        childIndex: sourceId === "child" ? 0 : null,
        archived: true,
        archiveStore: "archiveOld" as const,
        timeEntries: [
          {
            workDate: "2026-09-20",
            durationMs: sourceId === "child" ? minutes(50) : minutes(10),
            kind:
              sourceId === "child"
                ? ("task_day" as const)
                : ("parent_residual" as const),
            sourceTaskId: sourceId,
            sourceStore: "archiveOld" as const,
          },
        ],
      })),
    ];
    const today = {
      contextKind: "today" as const,
      sourceContextId: "TODAY",
      workDate: "2026-09-20",
      startedAt: "2026-09-20T13:00:00.000Z",
      endedAt: "2026-09-20T22:00:00.000Z",
      breakCount: 2,
      breakMs: minutes(25),
      sourceStore: "archiveOld" as const,
    };
    const workContexts = [
      today,
      {
        contextKind: "project" as const,
        sourceContextId: "p1",
        workDate: "2026-09-20",
        startedAt: "2026-09-20T14:00:00.000Z",
        endedAt: "2026-09-20T21:00:00.000Z",
        breakCount: null,
        breakMs: null,
        sourceStore: "archiveOld" as const,
      },
    ];
    expect(
      db.importTaskRecords("owner", records, now, { workContexts }),
    ).toEqual({ created: 3, existing: 0 });
    // Replaying the same export creates nothing and adds no time.
    expect(
      db.importTaskRecords("owner", records, now, { workContexts }),
    ).toEqual({ created: 0, existing: 3 });
    // A changed work-day record in a later export is refused as a whole.
    expect(() =>
      db.importTaskRecords("owner", records, now, {
        workContexts: [{ ...today, breakCount: 3 }],
      }),
    ).toThrow("IMPORT_SOURCE_CHANGED");
    const report = (database: SuiteDatabase) =>
      database.timeEntries.report({
        ownerId: "owner",
        from: "2026-09-20",
        to: "2026-09-20",
        timeZone: zone,
        now,
      });
    const before = report(db);
    expect(before.totalMs).toBe(minutes(60));
    expect(before.days[0]).toMatchObject({
      workStart: "2026-09-20T13:00:00.000Z",
      workEnd: "2026-09-20T22:00:00.000Z",
      breakCount: 2,
      breakMs: minutes(25),
    });
    const parent = before.tasks.find((row) => row.title === "Quarterly report");
    const child = before.tasks.find((row) => row.title === "Collect numbers");
    expect(parent).toMatchObject({
      archived: true,
      ownMs: minutes(10),
      childrenMs: minutes(50),
      allTimeMs: minutes(60),
      rollupEstimateMinutes: 60,
    });
    expect(child).toMatchObject({
      ownMs: minutes(50),
      parentId: parent?.taskId,
    });
    expect(before.projects).toEqual([
      expect.objectContaining({ title: "Client work", totalMs: minutes(60) }),
    ]);
    const imported = before.entries.find(
      (entry) => "source" in entry && entry.taskId === child?.taskId,
    );
    expect(imported).toMatchObject({
      source: "import",
      provenance: {
        source: "super_productivity",
        kind: "task_day",
        sourceTaskId: "child",
        sourceStore: "archiveOld",
      },
    });
    // Archived history is read-only, in the store and in SQLite.
    expect(
      db.timeEntries.update({
        ownerId: "owner",
        id: imported?.id ?? "",
        expectedRevision: 1,
        patch: { durationMs: minutes(5) },
        timeZone: zone,
        now,
      }),
    ).toEqual({ kind: "invalid", code: "task_unavailable" });
    expect(
      add(db, ids.entry, minutes(5), "2026-09-20", child?.taskId).kind,
    ).toBe("invalid");
    db.close();
    const raw = new DatabaseSync(join(directory, "suite.sqlite"));
    expect(() =>
      raw
        .prepare("UPDATE time_entries SET duration_ms=1 WHERE id=?")
        .run(imported?.id ?? ""),
    ).toThrow("archived task time is read-only");
    expect(() =>
      raw
        .prepare("DELETE FROM time_entries WHERE id=?")
        .run(imported?.id ?? ""),
    ).toThrow("archived task time is read-only");
    raw.close();

    const reopened = SuiteDatabase.open(join(directory, "suite.sqlite"));
    reopened.backup(join(directory, "backup", "suite.sqlite"));
    reopened.close();
    const restored = SuiteDatabase.open(
      join(directory, "backup", "suite.sqlite"),
    );
    expect(report(restored)).toEqual(before);
    restored.close();
  });
});

it("edits an imported entry on an active task but keeps it positive", async () => {
  await withTemporaryDirectory((directory) => {
    const db = open(directory);
    const record = {
      kind: "task" as const,
      sourceId: "live",
      sourceHash: "live",
      sourceJson: "{}",
      title: "Live task",
      notes: "",
      projectId: null,
      tagIds: [],
      plannedStart: null,
      deadlineDate: null,
      deadlineAt: null,
      estimateMinutes: null,
      completedAt: null,
      createdAt: now,
      timeEntries: [
        {
          workDate: "2026-09-21",
          durationMs: minutes(40),
          kind: "task_day" as const,
          sourceTaskId: "live",
          sourceStore: "task" as const,
        },
      ],
    };
    db.importTaskRecords("owner", [record], now);
    const [entry] = db.timeEntries.report({
      ownerId: "owner",
      from: "2026-09-21",
      to: "2026-09-21",
      timeZone: zone,
      now,
    }).entries;
    const update = (durationMs: number, workDate?: string) =>
      db.timeEntries.update({
        ownerId: "owner",
        id: entry?.id ?? "",
        expectedRevision: 1,
        patch: { durationMs, ...(workDate === undefined ? {} : { workDate }) },
        timeZone: zone,
        now,
      });
    expect(update(-minutes(5))).toEqual({
      kind: "invalid",
      code: "duration_invalid",
    });
    expect(update(minutes(35), "2026-09-22")).toMatchObject({
      kind: "applied",
      entry: {
        source: "import",
        workDate: "2026-09-22",
        durationMs: minutes(35),
        revision: 2,
        provenance: { sourceWorkDate: "2026-09-21" },
      },
    });
    db.close();
  });
});
