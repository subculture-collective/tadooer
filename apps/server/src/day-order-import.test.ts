import { join } from "node:path";
import { expect, it } from "vitest";
import { prepareSuperProductivityImport } from "@suite/import-export";
import { SuiteDatabase } from "@suite/persistence";
import { withTemporaryDirectory } from "@suite/test-support";

const now = "2026-09-24T12:00:00.000Z";
const store = (entities: Record<string, unknown>) => ({
  ids: Object.keys(entities),
  entities,
});

// Today and planner-day order (#98, ADR 0027) applied in the import
// transaction, kept across restart and never overwritten by a repeat import.
it("imports Today and planner-day orders once, with missing references reported", async () => {
  const raw = JSON.stringify({
    task: store({
      b: { id: "b", title: "Bravo", dueDay: "2026-09-24", created: 1 },
      a: { id: "a", title: "Alpha", dueDay: "2026-09-24", created: 1 },
      c: { id: "c", title: "Charlie", dueDay: "2026-09-24", created: 1 },
      n: { id: "n", title: "Next", dueDay: "2026-09-27", created: 1 },
      m: { id: "m", title: "More", dueDay: "2026-09-27", created: 1 },
    }),
    project: store({}),
    tag: store({
      TODAY: { id: "TODAY", title: "Today", taskIds: ["c", "gone", "a"] },
    }),
    planner: { days: { "2026-09-27": ["m", "n"] } },
  });
  const prepared = prepareSuperProductivityImport(raw, {
    timeZone: "America/Chicago",
    today: "2026-09-24",
  });
  expect(prepared.report.canApply).toBe(true);
  expect(
    prepared.report.issues.filter(({ code }) => code === "day_order_notice"),
  ).toHaveLength(2);

  await withTemporaryDirectory((directory) => {
    const path = join(directory, "db.sqlite");
    let db = SuiteDatabase.open(path);
    db.createOwner({
      id: "owner",
      username: "owner",
      displayName: "Owner",
      passwordHash: "hash",
      createdAt: now,
    });
    const apply = () =>
      db.importTaskRecords(
        "owner",
        prepared.records,
        now,
        prepared.recurrence,
        {
          workContexts: prepared.workContexts,
          dayOrders: prepared.dayOrders,
        },
      );
    expect(apply()).toMatchObject({ created: 5, dayOrders: 2 });
    const titles = (date: string) => {
      const byId = new Map(
        db.listTasks("owner").map((task) => [task.id, task.title]),
      );
      return db.dayOrders.get("owner", date).taskIds.map((id) => byId.get(id));
    };
    // Unranked Bravo follows the imported ranks.
    expect(titles("2026-09-24")).toEqual(["Charlie", "Alpha", "Bravo"]);
    expect(titles("2026-09-27")).toEqual(["More", "Next"]);

    // The owner reorders; a repeat import leaves the saved order alone.
    const today = db.dayOrders.get("owner", "2026-09-24");
    db.dayOrders.reorder({
      ownerId: "owner",
      date: "2026-09-24",
      expectedRevision: today.revision,
      taskIds: [...today.taskIds].toReversed(),
      now,
    });
    db.close();
    db = SuiteDatabase.open(path);
    expect(apply()).toMatchObject({ created: 0, existing: 5, dayOrders: 0 });
    expect(titles("2026-09-24")).toEqual(["Bravo", "Alpha", "Charlie"]);
    expect(db.dayOrders.get("owner", "2026-09-24").revision).toBe(2);
    db.close();
  });
});
