import type { DatabaseSync } from "node:sqlite";

/**
 * Saved day order (issue #98, ADR 0027). One record per owner and calendar
 * date ranks task IDs. Membership is derived from the tasks: open, active
 * (not deleted or archived), no planned start, and a planned day equal to the
 * date. Saved IDs that stopped being members are ignored when read and pruned
 * by the next write of that date; hard-deleted tasks cascade away.
 *
 * Saved day orders are sync feed records (ADR 0050): every write of a date
 * goes through `#write`, which appends the feed change in the caller's
 * transaction, so the browser routes, the assistant, the importer and the
 * sync outbox cannot save an order the feed does not carry. The feed record
 * is the saved ranks (`getSaved`); members stay derived from the tasks.
 */
export const dayOrderMigration = {
  id: "0031_day_order",
  sql: `
      CREATE TABLE day_orders (
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        day TEXT NOT NULL CHECK (length(day) = 10 AND date(day) IS day),
        revision INTEGER NOT NULL CHECK (revision > 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (owner_id, day)
      ) STRICT;
      CREATE TABLE day_order_entries (
        owner_id TEXT NOT NULL,
        day TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position >= 0),
        PRIMARY KEY (owner_id, day, task_id),
        UNIQUE (owner_id, day, position),
        FOREIGN KEY (owner_id, day) REFERENCES day_orders(owner_id, day)
          ON DELETE CASCADE
      ) STRICT;
      CREATE TRIGGER day_order_entries_owner
      BEFORE INSERT ON day_order_entries
      WHEN NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = NEW.task_id
        AND t.owner_id = NEW.owner_id)
      BEGIN
        SELECT RAISE(ABORT, 'day order task belongs to another owner');
      END;
      ALTER TABLE owner_planning_preferences ADD COLUMN day_starts_at TEXT
        NOT NULL DEFAULT '00:00'
        CHECK (length(day_starts_at) = 5 AND day_starts_at GLOB '[0-2][0-9]:[0-5][0-9]'
          AND day_starts_at <= '23:59');
    `,
};

export interface DayOrderRecord {
  readonly date: string;
  /** 0 before the first saved write of the date. */
  readonly revision: number;
  /** Current members: saved ranks first, then task ID order. */
  readonly taskIds: readonly string[];
}

/** The saved ranks of one date, as the sync feed carries them (ADR 0050). */
export interface SavedDayOrderRecord {
  readonly date: string;
  readonly revision: number;
  /** Saved ranks; may name tasks that stopped being members. */
  readonly taskIds: readonly string[];
  readonly updatedAt: string;
}

/**
 * Appends one sync feed change for a date's saved order inside the caller's
 * transaction (ADR 0050).
 */
export type DayOrderChangeAppender = (
  ownerId: string,
  date: string,
  revision: number,
  now: string,
) => void;

export type DayOrderSyncResult =
  | { readonly kind: "applied"; readonly saved: SavedDayOrderRecord }
  | {
      readonly kind: "conflict";
      readonly saved: SavedDayOrderRecord | undefined;
    };

export type DayOrderReorderResult =
  | { readonly kind: "applied"; readonly dayOrder: DayOrderRecord }
  | {
      readonly kind: "conflict";
      readonly reason: "revision" | "membership";
      readonly dayOrder: DayOrderRecord;
    };

export type DayOrderPlanResult =
  | {
      readonly kind: "applied";
      readonly dayOrder: DayOrderRecord;
      readonly taskIds: readonly string[];
    }
  | { readonly kind: "conflict"; readonly dayOrder: DayOrderRecord }
  | { readonly kind: "task-conflict"; readonly taskId: string }
  | { readonly kind: "task-invalid"; readonly taskId: string }
  /** The task has a calendar block, which is calendar-authoritative (ADR 0020). */
  | { readonly kind: "task-blocked"; readonly taskId: string };

export interface DayOrderStoreDeps {
  /**
   * Sets a task's planned day with a revision check. Runs inside the plan
   * transaction and reports whether the task changed.
   */
  readonly planTask: (
    ownerId: string,
    taskId: string,
    expectedRevision: number,
    date: string,
    now: string,
  ) => "applied" | "unchanged" | "conflict" | "invalid" | "blocked";
}

type Row = Record<string, string | number | null>;

export class SqliteDayOrderStore {
  readonly #database: DatabaseSync;
  readonly #deps: DayOrderStoreDeps;
  readonly #appendChange: DayOrderChangeAppender;

  constructor(
    database: DatabaseSync,
    deps: DayOrderStoreDeps,
    appendChange: DayOrderChangeAppender,
  ) {
    this.#database = database;
    this.#deps = deps;
    this.#appendChange = appendChange;
  }

  /** ADR 0050: every saved order of the owner, by date, for a snapshot. */
  listSaved(ownerId: string): readonly SavedDayOrderRecord[] {
    const orders = new Map<
      string,
      SavedDayOrderRecord & { taskIds: string[] }
    >();
    for (const row of this.#database
      .prepare(
        "SELECT day, revision, updated_at FROM day_orders WHERE owner_id = ? ORDER BY day",
      )
      .all(ownerId) as unknown as readonly Row[])
      orders.set(String(row.day), {
        date: String(row.day),
        revision: Number(row.revision),
        taskIds: [],
        updatedAt: String(row.updated_at),
      });
    for (const row of this.#database
      .prepare(
        "SELECT day, task_id FROM day_order_entries WHERE owner_id = ? ORDER BY day, position",
      )
      .all(ownerId) as unknown as readonly Row[])
      orders.get(String(row.day))?.taskIds.push(String(row.task_id));
    return [...orders.values()];
  }

  /** ADR 0050: the saved ranks of one date; undefined before a first write. */
  getSaved(ownerId: string, date: string): SavedDayOrderRecord | undefined {
    const row = this.#database
      .prepare(
        "SELECT revision, updated_at FROM day_orders WHERE owner_id = ? AND day = ?",
      )
      .get(ownerId, date) as unknown as Row | undefined;
    if (row === undefined) return undefined;
    return {
      date,
      revision: Number(row.revision),
      taskIds: (
        this.#database
          .prepare(
            "SELECT task_id FROM day_order_entries WHERE owner_id = ? AND day = ? ORDER BY position",
          )
          .all(ownerId, date) as unknown as readonly Row[]
      ).map((entry) => String(entry.task_id)),
      updatedAt: String(row.updated_at),
    };
  }

  /** Members of each date in [from, to], in task ID order. */
  #members(ownerId: string, from: string, to: string): Map<string, string[]> {
    const rows = this.#database
      .prepare(
        `SELECT id, planned_day FROM tasks
         WHERE owner_id = ? AND deleted_at IS NULL AND archived_at IS NULL
           AND status = 'open' AND planned_start IS NULL
           AND planned_day BETWEEN ? AND ?
         ORDER BY planned_day, id`,
      )
      .all(ownerId, from, to) as unknown as readonly Row[];
    const byDay = new Map<string, string[]>();
    for (const row of rows) {
      const day = String(row.planned_day);
      byDay.set(day, [...(byDay.get(day) ?? []), String(row.id)]);
    }
    return byDay;
  }

  #saved(
    ownerId: string,
    from: string,
    to: string,
  ): Map<string, { revision: number; taskIds: string[] }> {
    const saved = new Map<string, { revision: number; taskIds: string[] }>();
    for (const row of this.#database
      .prepare(
        "SELECT day, revision FROM day_orders WHERE owner_id = ? AND day BETWEEN ? AND ?",
      )
      .all(ownerId, from, to) as unknown as readonly Row[])
      saved.set(String(row.day), {
        revision: Number(row.revision),
        taskIds: [],
      });
    for (const row of this.#database
      .prepare(
        `SELECT day, task_id FROM day_order_entries
         WHERE owner_id = ? AND day BETWEEN ? AND ? ORDER BY day, position`,
      )
      .all(ownerId, from, to) as unknown as readonly Row[])
      saved.get(String(row.day))?.taskIds.push(String(row.task_id));
    return saved;
  }

  #compose(
    date: string,
    members: readonly string[],
    saved: { revision: number; taskIds: readonly string[] } | undefined,
  ): DayOrderRecord {
    const present = new Set(members);
    const ranked = (saved?.taskIds ?? []).filter((id) => present.has(id));
    const rankedSet = new Set(ranked);
    return {
      date,
      revision: saved?.revision ?? 0,
      taskIds: [...ranked, ...members.filter((id) => !rankedSet.has(id))],
    };
  }

  get(ownerId: string, date: string): DayOrderRecord {
    return this.#compose(
      date,
      this.#members(ownerId, date, date).get(date) ?? [],
      this.#saved(ownerId, date, date).get(date),
    );
  }

  /** Dates in [from, to] that have members or a saved order. */
  list(ownerId: string, from: string, to: string): readonly DayOrderRecord[] {
    const members = this.#members(ownerId, from, to);
    const saved = this.#saved(ownerId, from, to);
    return [...new Set([...members.keys(), ...saved.keys()])]
      .toSorted()
      .map((date) =>
        this.#compose(date, members.get(date) ?? [], saved.get(date)),
      )
      .filter(({ revision, taskIds }) => revision > 0 || taskIds.length > 0);
  }

  /**
   * Replace the saved list with exactly the current members and append the
   * feed change (ADR 0050). Every write of a saved order passes through here.
   */
  #write(
    ownerId: string,
    date: string,
    taskIds: readonly string[],
    now: string,
  ): void {
    const current = this.#database
      .prepare("SELECT revision FROM day_orders WHERE owner_id = ? AND day = ?")
      .get(ownerId, date) as unknown as Row | undefined;
    if (current === undefined)
      this.#database
        .prepare(
          "INSERT INTO day_orders (owner_id, day, revision, updated_at) VALUES (?, ?, 1, ?)",
        )
        .run(ownerId, date, now);
    else
      this.#database
        .prepare(
          "UPDATE day_orders SET revision = revision + 1, updated_at = ? WHERE owner_id = ? AND day = ?",
        )
        .run(now, ownerId, date);
    this.#database
      .prepare("DELETE FROM day_order_entries WHERE owner_id = ? AND day = ?")
      .run(ownerId, date);
    const insert = this.#database.prepare(
      "INSERT INTO day_order_entries (owner_id, day, task_id, position) VALUES (?, ?, ?, ?)",
    );
    taskIds.forEach((taskId, position) => {
      insert.run(ownerId, date, taskId, position);
    });
    this.#appendChange(
      ownerId,
      date,
      current === undefined ? 1 : Number(current.revision) + 1,
      now,
    );
  }

  #savedIds(ownerId: string, date: string): readonly string[] {
    return this.#saved(ownerId, date, date).get(date)?.taskIds ?? [];
  }

  #inSavepoint<T>(name: string, run: () => T): T {
    this.#database.exec(`SAVEPOINT ${name};`);
    try {
      const result = run();
      this.#database.exec(`RELEASE SAVEPOINT ${name};`);
      return result;
    } catch (error) {
      this.#database.exec(
        `ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name};`,
      );
      throw error;
    }
  }

  /**
   * Full-list reorder. Fails without changes when the revision is stale or
   * the list is not exactly the current members. Resubmitting the saved order
   * with the current revision changes nothing and keeps the revision.
   */
  reorder(input: {
    readonly ownerId: string;
    readonly date: string;
    readonly expectedRevision: number;
    readonly taskIds: readonly string[];
    readonly now: string;
  }): DayOrderReorderResult {
    return this.#inSavepoint("day_order_reorder", () => {
      const current = this.get(input.ownerId, input.date);
      if (current.revision !== input.expectedRevision)
        return { kind: "conflict", reason: "revision", dayOrder: current };
      const members = new Set(current.taskIds);
      if (
        input.taskIds.length !== members.size ||
        new Set(input.taskIds).size !== input.taskIds.length ||
        !input.taskIds.every((id) => members.has(id))
      )
        return { kind: "conflict", reason: "membership", dayOrder: current };
      const saved = this.#savedIds(input.ownerId, input.date);
      if (
        current.revision > 0 &&
        saved.length === input.taskIds.length &&
        saved.every((id, index) => input.taskIds[index] === id)
      )
        return { kind: "applied", dayOrder: current };
      this.#write(input.ownerId, input.date, input.taskIds, input.now);
      return { kind: "applied", dayOrder: this.get(input.ownerId, input.date) };
    });
  }

  /**
   * ADR 0050: a reorder from the sync outbox. Only the revision guards it:
   * a base revision that is not the saved one (0 when nothing is saved) is a
   * conflict that changes nothing. Membership is reconciled instead of
   * checked, because the client derived it from its own cache: named tasks
   * that are no longer members are dropped, and members the client did not
   * name follow in their current order. An applied reorder always writes,
   * so the revision is the base plus one, as the client assumed.
   */
  reorderFromSync(input: {
    readonly ownerId: string;
    readonly date: string;
    readonly baseRevision: number;
    readonly taskIds: readonly string[];
    readonly now: string;
  }): DayOrderSyncResult {
    return this.#inSavepoint("day_order_sync", () => {
      const saved = this.getSaved(input.ownerId, input.date);
      if ((saved?.revision ?? 0) !== input.baseRevision)
        return { kind: "conflict", saved };
      const members = this.get(input.ownerId, input.date).taskIds;
      const present = new Set(members);
      const named = [...new Set(input.taskIds)].filter((id) => present.has(id));
      const namedSet = new Set(named);
      this.#write(
        input.ownerId,
        input.date,
        [...named, ...members.filter((id) => !namedSet.has(id))],
        input.now,
      );
      const written = this.getSaved(input.ownerId, input.date);
      if (written === undefined) throw new Error("Saved day order is missing");
      return { kind: "applied", saved: written };
    });
  }

  /**
   * Plan tasks for a date: set each planned day (clearing a planned start)
   * and place the tasks after the date's other members in request order. All
   * or nothing.
   */
  plan(input: {
    readonly ownerId: string;
    readonly date: string;
    readonly expectedRevision: number;
    readonly tasks: readonly {
      readonly taskId: string;
      readonly expectedRevision: number;
    }[];
    readonly now: string;
  }): DayOrderPlanResult {
    this.#database.exec("SAVEPOINT day_order_plan;");
    const rollback = () =>
      this.#database.exec(
        "ROLLBACK TO SAVEPOINT day_order_plan; RELEASE SAVEPOINT day_order_plan;",
      );
    try {
      const before = this.get(input.ownerId, input.date);
      if (before.revision !== input.expectedRevision) {
        rollback();
        return { kind: "conflict", dayOrder: before };
      }
      for (const task of input.tasks) {
        const outcome = this.#deps.planTask(
          input.ownerId,
          task.taskId,
          task.expectedRevision,
          input.date,
          input.now,
        );
        if (
          outcome === "conflict" ||
          outcome === "invalid" ||
          outcome === "blocked"
        ) {
          rollback();
          return {
            kind:
              outcome === "conflict"
                ? "task-conflict"
                : outcome === "blocked"
                  ? "task-blocked"
                  : "task-invalid",
            taskId: task.taskId,
          };
        }
      }
      const planned = input.tasks.map(({ taskId }) => taskId);
      const plannedSet = new Set(planned);
      const members = this.get(input.ownerId, input.date).taskIds;
      const order = [
        ...before.taskIds.filter(
          (id) => !plannedSet.has(id) && members.includes(id),
        ),
        ...members.filter(
          (id) => !plannedSet.has(id) && !before.taskIds.includes(id),
        ),
        ...planned,
      ];
      this.#write(input.ownerId, input.date, order, input.now);
      this.#database.exec("RELEASE SAVEPOINT day_order_plan;");
      return {
        kind: "applied",
        dayOrder: this.get(input.ownerId, input.date),
        taskIds: planned,
      };
    } catch (error) {
      rollback();
      throw error;
    }
  }

  /**
   * Import (ADR 0027): save each date's order only when the date has no saved
   * order yet, so a repeated import never overwrites the owner's edits. IDs
   * that are not current members are dropped; an empty result saves nothing.
   */
  importOrders(
    ownerId: string,
    orders: readonly {
      readonly date: string;
      readonly taskIds: readonly string[];
    }[],
    now: string,
  ): number {
    let saved = 0;
    for (const order of orders) {
      const current = this.get(ownerId, order.date);
      if (current.revision > 0) continue;
      const members = new Set(current.taskIds);
      const ranked = [...new Set(order.taskIds)].filter((id) =>
        members.has(id),
      );
      if (ranked.length === 0) continue;
      const rankedSet = new Set(ranked);
      this.#write(
        ownerId,
        order.date,
        [...ranked, ...current.taskIds.filter((id) => !rankedSet.has(id))],
        now,
      );
      saved++;
    }
    return saved;
  }
}
