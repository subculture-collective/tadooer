import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import {
  SuiteDatabase,
  type CounterDefinitionInput,
  type ImportedCounter,
  type ImportedEvaluation,
} from "./index.ts";

// Counters and daily evaluations (issue #64, ADR 0025).
const zone = "America/Chicago";
const now = "2026-09-24T17:00:00.000Z";
const hour = 3_600_000;
const ids = {
  click: "00000000-0000-4000-8000-000000000001",
  watch: "00000000-0000-4000-8000-000000000002",
  other: "00000000-0000-4000-8000-000000000003",
};

const open = (directory: string) => {
  const db = SuiteDatabase.open(join(directory, "suite.sqlite"));
  for (const owner of ["owner", "stranger"])
    db.createOwner({
      id: owner,
      username: owner,
      displayName: owner,
      passwordHash: "hash",
      createdAt: now,
    });
  return db;
};

const definition = (
  overrides: Partial<CounterDefinitionInput> = {},
): CounterDefinitionInput => ({
  title: "Water",
  kind: "click",
  icon: "local_drink",
  enabled: true,
  hidden: false,
  streak: {
    enabled: true,
    minValue: 2,
    mode: "weekdays",
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    weeklyFrequency: 3,
  },
  countdownMs: null,
  ...overrides,
});

const create = (
  db: SuiteDatabase,
  id: string,
  overrides: Partial<CounterDefinitionInput> = {},
  ownerId = "owner",
) => {
  const result = db.counters.create({
    ownerId,
    id,
    counter: definition(overrides),
    now,
  });
  if (result.kind !== "applied") throw new Error(result.kind);
  return result.counter;
};

const record = (
  db: SuiteDatabase,
  input: {
    readonly counterId?: string;
    readonly day: string;
    readonly action?: "set" | "increment";
    readonly amount: number;
    readonly expectedRevision: number;
    readonly ownerId?: string;
  },
) =>
  db.counters.recordDay({
    ownerId: input.ownerId ?? "owner",
    counterId: input.counterId ?? ids.click,
    day: input.day,
    action: input.action ?? "set",
    amount: input.amount,
    expectedRevision: input.expectedRevision,
    timeZone: zone,
    now,
  });

it("creates counters with replay-safe IDs and keeps owners apart", async () => {
  await withTemporaryDirectory((directory) => {
    const db = open(directory);
    create(db, ids.click);
    expect(
      db.counters.create({
        ownerId: "owner",
        id: ids.click,
        counter: definition(),
        now,
      }).kind,
    ).toBe("replayed");
    expect(
      db.counters.create({
        ownerId: "owner",
        id: ids.click,
        counter: definition({ title: "Tea" }),
        now,
      }).kind,
    ).toBe("exists");
    expect(
      db.counters.create({
        ownerId: "owner",
        id: ids.other,
        counter: definition({ countdownMs: 60_000 }),
        now,
      }),
    ).toEqual({ kind: "invalid", code: "countdown_invalid" });

    // Another owner neither sees nor writes the counter.
    expect(db.counters.list("stranger")).toEqual([]);
    expect(
      record(db, {
        day: "2026-09-24",
        amount: 1,
        expectedRevision: 0,
        ownerId: "stranger",
      }).kind,
    ).toBe("not-found");
    expect(
      db.counters.update({
        ownerId: "stranger",
        id: ids.click,
        expectedRevision: 1,
        patch: { title: "Mine" },
        now,
      }).kind,
    ).toBe("not-found");
    db.close();
    const raw = new DatabaseSync(join(directory, "suite.sqlite"));
    expect(() =>
      raw
        .prepare(
          "INSERT INTO counter_day_values (owner_id,counter_id,day,value,revision,updated_at) VALUES ('stranger',?,'2026-09-24',1,1,?)",
        )
        .run(ids.click, now),
    ).toThrow("counter day value needs a live counter of the same owner");
    raw.close();
  });
});

it("rejects a stale day revision so concurrent edits never overwrite each other", async () => {
  await withTemporaryDirectory((directory) => {
    const db = open(directory);
    create(db, ids.click);
    const first = record(db, {
      day: "2026-09-24",
      amount: 3,
      expectedRevision: 0,
    });
    expect(first).toMatchObject({
      kind: "applied",
      values: [
        { day: "2026-09-24", value: 3, revision: 1, importedValue: null },
      ],
    });
    // Two devices read revision 1; the second write is refused.
    expect(
      record(db, {
        day: "2026-09-24",
        action: "increment",
        amount: 1,
        expectedRevision: 1,
      }),
    ).toMatchObject({ kind: "applied", values: [{ value: 4, revision: 2 }] });
    expect(
      record(db, {
        day: "2026-09-24",
        action: "increment",
        amount: 1,
        expectedRevision: 1,
      }),
    ).toEqual({ kind: "precondition-failed", revision: 2 });
    // A new day expects revision 0; a decrement stops at zero.
    expect(
      record(db, { day: "2026-09-23", amount: 1, expectedRevision: 1 }).kind,
    ).toBe("precondition-failed");
    expect(
      record(db, {
        day: "2026-09-24",
        action: "increment",
        amount: -10,
        expectedRevision: 2,
      }),
    ).toMatchObject({ kind: "applied", values: [{ value: 0, revision: 3 }] });
    expect(
      record(db, { day: "2026-09-24", amount: 1_000_001, expectedRevision: 3 }),
    ).toEqual({ kind: "invalid", code: "value_exceeds_day" });

    const counter = db.counters.get("owner", ids.click);
    expect(
      db.counters.update({
        ownerId: "owner",
        id: ids.click,
        expectedRevision: (counter?.revision ?? 0) + 1,
        patch: { title: "Stale" },
        now,
      }).kind,
    ).toBe("precondition-failed");
    expect(
      db.counters.update({
        ownerId: "owner",
        id: ids.click,
        expectedRevision: 1,
        patch: { enabled: false },
        now,
      }),
    ).toMatchObject({
      kind: "applied",
      counter: { enabled: false, revision: 2 },
    });
    expect(
      record(db, { day: "2026-09-22", amount: 1, expectedRevision: 0 }),
    ).toEqual({ kind: "invalid", code: "counter_disabled" });
    db.close();
  });
});

it("bounds stopwatch days by the owner-zone day length across daylight saving", async () => {
  await withTemporaryDirectory((directory) => {
    const db = open(directory);
    create(db, ids.watch, { title: "Standing desk", kind: "stopwatch" });
    const set = (day: string, value: number) =>
      record(db, {
        counterId: ids.watch,
        day,
        amount: value,
        expectedRevision: 0,
      });
    expect(set("2026-11-01", 25 * hour).kind).toBe("applied");
    expect(set("2026-09-24", 24 * hour + 1)).toEqual({
      kind: "invalid",
      code: "value_exceeds_day",
    });
    expect(set("2026-03-08", 23 * hour + 1)).toEqual({
      kind: "invalid",
      code: "value_exceeds_day",
    });
    expect(set("2026-03-08", 23 * hour).kind).toBe("applied");
    db.close();
  });
});

it("splits a stopwatch run at the owner's midnight and derives the streak", async () => {
  await withTemporaryDirectory((directory) => {
    const db = open(directory);
    create(db, ids.watch, {
      title: "Standing desk",
      kind: "stopwatch",
      streak: {
        enabled: true,
        minValue: 30 * 60_000,
        mode: "weekdays",
        weekdays: [0, 1, 2, 3, 4, 5, 6],
        weeklyFrequency: 3,
      },
    });
    // 23:30 CDT on September 23.
    const started = db.counters.startStopwatch({
      ownerId: "owner",
      id: ids.watch,
      expectedRevision: 1,
      now: "2026-09-24T04:30:00.000Z",
    });
    expect(started).toMatchObject({
      kind: "applied",
      counter: { runningSince: "2026-09-24T04:30:00.000Z", revision: 2 },
    });
    expect(
      db.counters.startStopwatch({
        ownerId: "owner",
        id: ids.watch,
        expectedRevision: 2,
        now,
      }),
    ).toEqual({ kind: "invalid", code: "stopwatch_running" });
    expect(
      db.counters.update({
        ownerId: "owner",
        id: ids.watch,
        expectedRevision: 2,
        patch: { enabled: false },
        now,
      }),
    ).toEqual({ kind: "invalid", code: "stopwatch_running" });
    // Stopped at 00:15 CDT on September 24.
    const stopped = db.counters.stopStopwatch({
      ownerId: "owner",
      id: ids.watch,
      expectedRevision: 2,
      timeZone: zone,
      now: "2026-09-24T05:15:00.000Z",
    });
    expect(stopped).toMatchObject({
      kind: "applied",
      counter: { runningSince: null, revision: 3 },
      values: [
        { day: "2026-09-23", value: 30 * 60_000, revision: 1 },
        { day: "2026-09-24", value: 15 * 60_000, revision: 1 },
      ],
      clampedMs: 0,
    });
    expect(
      db.counters.stopStopwatch({
        ownerId: "owner",
        id: ids.watch,
        expectedRevision: 3,
        timeZone: zone,
        now,
      }),
    ).toEqual({ kind: "invalid", code: "stopwatch_stopped" });

    const history = db.counters.history({
      ownerId: "owner",
      from: "2026-09-21",
      to: "2026-09-27",
      timeZone: zone,
      now,
    });
    expect(history.today).toBe("2026-09-24");
    // Today (15 minutes) is still open; the 23rd reached 30 minutes.
    expect(history.counters[0]?.currentStreak).toBe(1);
    expect(history.values.map(({ day }) => day)).toEqual([
      "2026-09-23",
      "2026-09-24",
    ]);

    // A day that already holds nearly its whole length is clamped on stop.
    expect(
      record(db, {
        counterId: ids.watch,
        day: "2026-09-25",
        amount: 24 * hour - 10 * 60_000,
        expectedRevision: 0,
      }).kind,
    ).toBe("applied");
    db.counters.startStopwatch({
      ownerId: "owner",
      id: ids.watch,
      expectedRevision: 3,
      now: "2026-09-25T20:00:00.000Z",
    });
    expect(
      db.counters.stopStopwatch({
        ownerId: "owner",
        id: ids.watch,
        expectedRevision: 4,
        timeZone: zone,
        now: "2026-09-25T20:30:00.000Z",
      }),
    ).toMatchObject({
      kind: "applied",
      values: [{ day: "2026-09-25", value: 24 * hour }],
      clampedMs: 20 * 60_000,
    });
    db.close();
  });
});

it("deletes a counter with its history and keeps a tombstone", async () => {
  await withTemporaryDirectory((directory) => {
    const db = open(directory);
    create(db, ids.click);
    record(db, { day: "2026-09-24", amount: 2, expectedRevision: 0 });
    expect(
      db.counters.delete({
        ownerId: "owner",
        id: ids.click,
        expectedRevision: 2,
        now,
      }).kind,
    ).toBe("precondition-failed");
    expect(
      db.counters.delete({
        ownerId: "owner",
        id: ids.click,
        expectedRevision: 1,
        now,
      }),
    ).toMatchObject({
      kind: "applied",
      counter: { deletedAt: now, revision: 2 },
    });
    expect(db.counters.list("owner")).toEqual([]);
    expect(db.counters.list("owner", true)).toHaveLength(1);
    expect(
      db.counters.dayValue("owner", ids.click, "2026-09-24"),
    ).toBeUndefined();
    expect(
      record(db, { day: "2026-09-24", amount: 1, expectedRevision: 0 }).kind,
    ).toBe("not-found");
    db.close();
  });
});

it("creates and edits a day's evaluation at the revision read", async () => {
  await withTemporaryDirectory((directory) => {
    const db = open(directory);
    const write = (
      expectedRevision: number,
      patch: object,
      ownerId = "owner",
    ) =>
      db.counters.writeEvaluation({
        ownerId,
        day: "2026-09-24",
        expectedRevision,
        patch,
        newId: () => ids.other,
        now,
      });
    expect(write(1, { impact: 3 })).toEqual({
      kind: "precondition-failed",
      revision: 0,
    });
    expect(
      write(0, { impact: 3, reflection: "Shipped the draft" }),
    ).toMatchObject({
      kind: "applied",
      evaluation: {
        id: ids.other,
        impact: 3,
        energy: null,
        reflection: "Shipped the draft",
        remindTomorrow: false,
        revision: 1,
        imported: false,
      },
    });
    expect(write(1, { energy: 2, impact: null })).toMatchObject({
      kind: "applied",
      evaluation: {
        impact: null,
        energy: 2,
        reflection: "Shipped the draft",
        revision: 2,
      },
    });
    expect(write(1, { notes: "Late" }).kind).toBe("precondition-failed");
    expect(
      db.counters.listEvaluations("stranger", "2026-09-01", "2026-09-30"),
    ).toEqual([]);
    db.close();
  });
});

const importedCounter = (
  values: ImportedCounter["values"],
  sourceHash = "counter-v1",
): ImportedCounter => ({
  ...definition({ title: "Coffee" }),
  sourceId: "COFFEE",
  sourceHash,
  sourceJson: "{}",
  values,
});
const importedEvaluation = (sourceHash = "metric-v1"): ImportedEvaluation => ({
  day: "2026-09-20",
  sourceHash,
  sourceJson: "{}",
  notes: "",
  reflection: "Calm day",
  impact: 4,
  energy: 3,
  remindTomorrow: false,
  focusSessionsMs: [25 * 60_000, 50 * 60_000],
});

it("imports counters and evaluations once and survives restart and backup", async () => {
  await withTemporaryDirectory((directory) => {
    let db = open(directory);
    const apply = (
      counters: readonly ImportedCounter[],
      evaluations: readonly ImportedEvaluation[] = [importedEvaluation()],
    ) =>
      db.importTaskRecords("owner", [], now, undefined, {
        counters,
        evaluations,
      });
    expect(
      apply([importedCounter([{ day: "2026-09-20", value: 2 }])]).counters,
    ).toEqual({
      created: 1,
      existing: 0,
      dayValuesCreated: 1,
      dayValuesExisting: 0,
      evaluationsCreated: 1,
      evaluationsExisting: 0,
    });
    const [counter] = db.counters.list("owner");
    expect(counter).toMatchObject({
      title: "Coffee",
      provenance: { source: "super_productivity", sourceCounterId: "COFFEE" },
    });
    db.close();

    // After a restart a replay adds nothing, keeps a local edit and adds a
    // day the earlier export did not have.
    db = SuiteDatabase.open(join(directory, "suite.sqlite"));
    expect(
      record(db, {
        counterId: counter?.id ?? "",
        day: "2026-09-20",
        amount: 5,
        expectedRevision: 1,
      }).kind,
    ).toBe("applied");
    expect(
      apply([
        importedCounter([
          { day: "2026-09-20", value: 2 },
          { day: "2026-09-21", value: 1 },
        ]),
      ]).counters,
    ).toEqual({
      created: 0,
      existing: 1,
      dayValuesCreated: 1,
      dayValuesExisting: 1,
      evaluationsCreated: 0,
      evaluationsExisting: 1,
    });
    expect(
      db.counters.dayValue("owner", counter?.id ?? "", "2026-09-20"),
    ).toMatchObject({ value: 5, importedValue: 2, revision: 2 });

    // A changed source day, definition or metric day aborts the whole import.
    const before = db.counters.history({
      ownerId: "owner",
      from: "2026-09-14",
      to: "2026-09-27",
      timeZone: zone,
      now,
    });
    for (const attempt of [
      () =>
        apply([
          importedCounter([
            { day: "2026-09-20", value: 3 },
            { day: "2026-09-22", value: 1 },
          ]),
        ]),
      () => apply([importedCounter([], "counter-v2")]),
      () => apply([], [importedEvaluation("metric-v2")]),
    ])
      expect(attempt).toThrow("IMPORT_SOURCE_CHANGED");
    // A source day that meets a value recorded in Tadooer also aborts.
    record(db, {
      counterId: counter?.id ?? "",
      day: "2026-09-23",
      amount: 1,
      expectedRevision: 0,
    });
    expect(() =>
      apply([importedCounter([{ day: "2026-09-23", value: 1 }])]),
    ).toThrow("IMPORT_SOURCE_CHANGED");
    const after = db.counters.history({
      ownerId: "owner",
      from: "2026-09-14",
      to: "2026-09-27",
      timeZone: zone,
      now,
    });
    expect(after.values.filter(({ day }) => day !== "2026-09-23")).toEqual(
      before.values,
    );

    db.backup(join(directory, "backup", "suite.sqlite"));
    db.close();
    const restored = SuiteDatabase.open(
      join(directory, "backup", "suite.sqlite"),
    );
    expect(
      restored.counters.history({
        ownerId: "owner",
        from: "2026-09-14",
        to: "2026-09-27",
        timeZone: zone,
        now,
      }),
    ).toEqual(after);
    expect(
      restored.counters.getEvaluation("owner", "2026-09-20"),
    ).toMatchObject({
      reflection: "Calm day",
      importedFocusSessionsMs: [25 * 60_000, 50 * 60_000],
      imported: true,
    });

    // A deleted imported counter is not recreated by a replay.
    const current = restored.counters.get("owner", counter?.id ?? "");
    restored.counters.delete({
      ownerId: "owner",
      id: counter?.id ?? "",
      expectedRevision: current?.revision ?? 0,
      now,
    });
    expect(
      restored.importTaskRecords("owner", [], now, undefined, {
        counters: [importedCounter([{ day: "2026-09-20", value: 2 }])],
      }).counters,
    ).toMatchObject({ created: 0, existing: 1, dayValuesCreated: 0 });
    expect(restored.counters.list("owner")).toEqual([]);
    restored.close();
  });
});
