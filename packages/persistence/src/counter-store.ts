import type { DatabaseSync } from "node:sqlite";
import {
  counterStreak,
  incrementedCounterValue,
  maxCounterDayValue,
  stopwatchDayShares,
  validateCounterDayValue,
  weekdayMask,
  weekdaysFromMask,
  zonedCalendarDate,
  type CounterKind,
  type CounterStreakSettings,
  type CounterValueViolation,
} from "@suite/domain";

/**
 * Simple counters and daily evaluations (issue #64, ADR 0025).
 *
 * `counters` holds owner-scoped definitions. A deleted counter keeps its row
 * as a tombstone, so a replayed import does not recreate it, but its day
 * values are removed. `counter_day_values` holds one revisioned whole number
 * per counter and owner-zone day: a count, or milliseconds for a stopwatch.
 * `daily_evaluations` holds one revisioned evaluation per owner and day.
 *
 * All three are online HTTP records, outside the sync change feed and the
 * offline cache. Streaks are derived on read. Mutations use savepoints so
 * they nest inside automation confirmation and import transactions.
 */
export const countersMigration = {
  id: "0029_counters_metrics",
  sql: `
      CREATE TABLE counters (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
        kind TEXT NOT NULL CHECK (kind IN ('click','stopwatch','repeated_countdown')),
        icon TEXT CHECK (icon IS NULL OR length(icon) BETWEEN 1 AND 64),
        enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
        hidden INTEGER NOT NULL CHECK (hidden IN (0,1)),
        position INTEGER NOT NULL,
        streak_enabled INTEGER NOT NULL CHECK (streak_enabled IN (0,1)),
        streak_min_value INTEGER NOT NULL CHECK (streak_min_value BETWEEN 1 AND 90000000),
        streak_mode TEXT NOT NULL CHECK (streak_mode IN ('weekdays','weekly_frequency')),
        streak_weekdays INTEGER NOT NULL CHECK (streak_weekdays BETWEEN 0 AND 127),
        streak_weekly_frequency INTEGER NOT NULL CHECK (streak_weekly_frequency BETWEEN 1 AND 7),
        countdown_ms INTEGER CHECK (countdown_ms IS NULL OR countdown_ms BETWEEN 1000 AND 86400000),
        running_since TEXT,
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        source_kind TEXT CHECK (source_kind IN ('super_productivity')),
        source_counter_id TEXT CHECK (length(source_counter_id) BETWEEN 1 AND 200),
        source_hash TEXT,
        source_json TEXT,
        CHECK ((source_kind IS NULL) = (source_counter_id IS NULL)),
        CHECK (source_kind IS NULL OR (source_hash IS NOT NULL AND source_json IS NOT NULL)),
        CHECK (countdown_ms IS NULL OR kind = 'repeated_countdown'),
        CHECK (running_since IS NULL OR (kind = 'stopwatch' AND deleted_at IS NULL))
      ) STRICT;
      CREATE INDEX counters_by_owner ON counters(owner_id, deleted_at, position);
      CREATE UNIQUE INDEX counters_import_identity
        ON counters(owner_id, source_kind, source_counter_id)
        WHERE source_kind IS NOT NULL;
      CREATE TABLE counter_day_values (
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        counter_id TEXT NOT NULL REFERENCES counters(id) ON DELETE CASCADE,
        day TEXT NOT NULL CHECK (length(day) = 10 AND date(day) IS day),
        value INTEGER NOT NULL CHECK (value BETWEEN 0 AND 90000000),
        revision INTEGER NOT NULL CHECK (revision > 0),
        updated_at TEXT NOT NULL,
        imported_value INTEGER CHECK (imported_value IS NULL OR imported_value >= 0),
        PRIMARY KEY (counter_id, day)
      ) STRICT;
      CREATE INDEX counter_day_values_by_day ON counter_day_values(owner_id, day);
      CREATE TRIGGER counter_day_values_owner
      BEFORE INSERT ON counter_day_values
      WHEN NOT EXISTS (SELECT 1 FROM counters c WHERE c.id = NEW.counter_id
        AND c.owner_id = NEW.owner_id AND c.deleted_at IS NULL)
      BEGIN
        SELECT RAISE(ABORT, 'counter day value needs a live counter of the same owner');
      END;
      CREATE TABLE daily_evaluations (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES owner_accounts(id) ON DELETE CASCADE,
        day TEXT NOT NULL CHECK (length(day) = 10 AND date(day) IS day),
        notes TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 5000),
        reflection TEXT NOT NULL DEFAULT '' CHECK (length(reflection) <= 5000),
        impact INTEGER CHECK (impact IS NULL OR impact BETWEEN 1 AND 4),
        energy INTEGER CHECK (energy IS NULL OR energy BETWEEN 1 AND 3),
        remind_tomorrow INTEGER NOT NULL CHECK (remind_tomorrow IN (0,1)),
        imported_focus_sessions_json TEXT NOT NULL DEFAULT '[]'
          CHECK (json_valid(imported_focus_sessions_json)),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        source_kind TEXT CHECK (source_kind IN ('super_productivity')),
        source_hash TEXT,
        source_json TEXT,
        CHECK ((source_kind IS NULL) = (source_hash IS NULL)),
        UNIQUE (owner_id, day)
      ) STRICT;
    `,
};

export interface CounterRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly kind: CounterKind;
  readonly icon: string | null;
  readonly enabled: boolean;
  readonly hidden: boolean;
  readonly position: number;
  readonly streak: CounterStreakSettings;
  readonly countdownMs: number | null;
  readonly runningSince: string | null;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly provenance: {
    readonly source: "super_productivity";
    readonly sourceCounterId: string;
  } | null;
}

export interface CounterDayValueRecord {
  readonly counterId: string;
  readonly day: string;
  readonly value: number;
  readonly revision: number;
  readonly updatedAt: string;
  readonly importedValue: number | null;
}

export interface DailyEvaluationRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly day: string;
  readonly notes: string;
  readonly reflection: string;
  readonly impact: number | null;
  readonly energy: number | null;
  readonly remindTomorrow: boolean;
  readonly importedFocusSessionsMs: readonly number[];
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly imported: boolean;
}

export type CounterViolation =
  | CounterValueViolation
  | "counter_disabled"
  | "not_stopwatch"
  | "stopwatch_running"
  | "stopwatch_stopped"
  | "countdown_invalid";

export type CounterWriteResult =
  | {
      readonly kind: "applied" | "replayed";
      readonly counter: CounterRecord;
      readonly values: readonly CounterDayValueRecord[];
      readonly clampedMs: number;
    }
  | { readonly kind: "not-found" }
  | {
      readonly kind: "precondition-failed";
      readonly revision: number;
    }
  | { readonly kind: "exists" }
  | { readonly kind: "invalid"; readonly code: CounterViolation };

export type EvaluationWriteResult =
  | { readonly kind: "applied"; readonly evaluation: DailyEvaluationRecord }
  | { readonly kind: "precondition-failed"; readonly revision: number };

export interface CounterDefinitionInput {
  readonly title: string;
  readonly kind: CounterKind;
  readonly icon: string | null;
  readonly enabled: boolean;
  readonly hidden: boolean;
  readonly streak: CounterStreakSettings;
  readonly countdownMs: number | null;
}

export interface CounterPatch {
  readonly title?: string | undefined;
  readonly icon?: string | null | undefined;
  readonly enabled?: boolean | undefined;
  readonly hidden?: boolean | undefined;
  readonly streak?: CounterStreakSettings | undefined;
  readonly countdownMs?: number | null | undefined;
}

export interface EvaluationPatch {
  readonly notes?: string | undefined;
  readonly reflection?: string | undefined;
  readonly impact?: number | null | undefined;
  readonly energy?: number | null | undefined;
  readonly remindTomorrow?: boolean | undefined;
}

/** A Super Productivity counter with its reviewed day values. */
export interface ImportedCounter extends CounterDefinitionInput {
  readonly sourceId: string;
  readonly sourceHash: string;
  readonly sourceJson: string;
  readonly values: readonly { readonly day: string; readonly value: number }[];
}

/** A Super Productivity metric day mapped to an evaluation. */
export interface ImportedEvaluation {
  readonly day: string;
  readonly sourceHash: string;
  readonly sourceJson: string;
  readonly notes: string;
  readonly reflection: string;
  readonly impact: number | null;
  readonly energy: number | null;
  readonly remindTomorrow: boolean;
  readonly focusSessionsMs: readonly number[];
}

export interface CounterImportOutcome {
  readonly created: number;
  readonly existing: number;
  readonly dayValuesCreated: number;
  readonly dayValuesExisting: number;
  readonly evaluationsCreated: number;
  readonly evaluationsExisting: number;
}

type Row = Record<string, string | number | null>;

const counterFromRow = (row: Row): CounterRecord => ({
  id: String(row.id),
  ownerId: String(row.owner_id),
  title: String(row.title),
  kind: String(row.kind) as CounterKind,
  icon: row.icon === null ? null : String(row.icon),
  enabled: row.enabled === 1,
  hidden: row.hidden === 1,
  position: Number(row.position),
  streak: {
    enabled: row.streak_enabled === 1,
    minValue: Number(row.streak_min_value),
    mode:
      row.streak_mode === "weekly_frequency" ? "weekly_frequency" : "weekdays",
    weekdays: weekdaysFromMask(Number(row.streak_weekdays)),
    weeklyFrequency: Number(row.streak_weekly_frequency),
  },
  countdownMs: row.countdown_ms === null ? null : Number(row.countdown_ms),
  runningSince: row.running_since === null ? null : String(row.running_since),
  revision: Number(row.revision),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
  deletedAt: row.deleted_at === null ? null : String(row.deleted_at),
  provenance:
    row.source_kind === "super_productivity"
      ? {
          source: "super_productivity",
          sourceCounterId: String(row.source_counter_id),
        }
      : null,
});

const valueFromRow = (row: Row): CounterDayValueRecord => ({
  counterId: String(row.counter_id),
  day: String(row.day),
  value: Number(row.value),
  revision: Number(row.revision),
  updatedAt: String(row.updated_at),
  importedValue:
    row.imported_value === null ? null : Number(row.imported_value),
});

const evaluationFromRow = (row: Row): DailyEvaluationRecord => ({
  id: String(row.id),
  ownerId: String(row.owner_id),
  day: String(row.day),
  notes: String(row.notes),
  reflection: String(row.reflection),
  impact: row.impact === null ? null : Number(row.impact),
  energy: row.energy === null ? null : Number(row.energy),
  remindTomorrow: row.remind_tomorrow === 1,
  importedFocusSessionsMs: JSON.parse(
    String(row.imported_focus_sessions_json),
  ) as number[],
  revision: Number(row.revision),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
  imported: row.source_kind !== null,
});

const sameStreak = (
  left: CounterStreakSettings,
  right: CounterStreakSettings,
) =>
  left.enabled === right.enabled &&
  left.minValue === right.minValue &&
  left.mode === right.mode &&
  weekdayMask(left.weekdays) === weekdayMask(right.weekdays) &&
  left.weeklyFrequency === right.weeklyFrequency;

export class SqliteCounterStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Live counters in display order; deleted tombstones only when asked. */
  list(ownerId: string, includeDeleted = false): CounterRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM counters WHERE owner_id=? AND (? = 1 OR deleted_at IS NULL)
           ORDER BY position, created_at, id`,
        )
        .all(ownerId, includeDeleted ? 1 : 0) as Row[]
    ).map(counterFromRow);
  }

  /** A counter, including a deleted tombstone. */
  get(ownerId: string, id: string): CounterRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM counters WHERE owner_id=? AND id=?")
      .get(ownerId, id) as Row | undefined;
    return row === undefined ? undefined : counterFromRow(row);
  }

  dayValue(
    ownerId: string,
    counterId: string,
    day: string,
  ): CounterDayValueRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM counter_day_values WHERE owner_id=? AND counter_id=? AND day=?",
      )
      .get(ownerId, counterId, day) as Row | undefined;
    return row === undefined ? undefined : valueFromRow(row);
  }

  /** A counter's derived streak on the owner's today; null when off. */
  currentStreak(counter: CounterRecord, today: string): number | null {
    if (!counter.streak.enabled || counter.deletedAt !== null) return null;
    const rows = this.db
      .prepare(
        "SELECT day, value FROM counter_day_values WHERE owner_id=? AND counter_id=?",
      )
      .all(counter.ownerId, counter.id) as Row[];
    return counterStreak(
      counter.streak,
      new Map(rows.map((row) => [String(row.day), Number(row.value)])),
      today,
    );
  }

  /**
   * Counters with their derived streak on the owner's today, and the day
   * values in the inclusive range.
   */
  history(input: {
    readonly ownerId: string;
    readonly from: string;
    readonly to: string;
    readonly timeZone: string;
    readonly now: string;
  }): {
    readonly today: string;
    readonly counters: readonly (CounterRecord & {
      readonly currentStreak: number | null;
    })[];
    readonly values: readonly CounterDayValueRecord[];
  } {
    const today = zonedCalendarDate(input.now, input.timeZone);
    const all = (
      this.db
        .prepare(
          `SELECT v.* FROM counter_day_values v JOIN counters c ON c.id = v.counter_id
           WHERE v.owner_id=? AND c.deleted_at IS NULL ORDER BY v.day, c.position, c.id`,
        )
        .all(input.ownerId) as Row[]
    ).map(valueFromRow);
    const byCounter = new Map<string, Map<string, number>>();
    for (const value of all) {
      const days = byCounter.get(value.counterId) ?? new Map<string, number>();
      days.set(value.day, value.value);
      byCounter.set(value.counterId, days);
    }
    return {
      today,
      counters: this.list(input.ownerId).map((counter) => ({
        ...counter,
        currentStreak: counterStreak(
          counter.streak,
          byCounter.get(counter.id) ?? new Map(),
          today,
        ),
      })),
      values: all.filter(
        (value) => value.day >= input.from && value.day <= input.to,
      ),
    };
  }

  /** Adds a counter. The client supplies the UUID, so a retry replays. */
  create(input: {
    readonly ownerId: string;
    readonly id: string;
    readonly counter: CounterDefinitionInput;
    readonly now: string;
  }): CounterWriteResult {
    return this.#transaction("counter_create", () => {
      const existing = this.db
        .prepare("SELECT * FROM counters WHERE id=?")
        .get(input.id) as Row | undefined;
      if (existing !== undefined) {
        const counter = counterFromRow(existing);
        const same =
          counter.ownerId === input.ownerId &&
          counter.deletedAt === null &&
          counter.title === input.counter.title &&
          counter.kind === input.counter.kind &&
          counter.icon === input.counter.icon &&
          counter.enabled === input.counter.enabled &&
          counter.hidden === input.counter.hidden &&
          counter.countdownMs === input.counter.countdownMs &&
          sameStreak(counter.streak, input.counter.streak);
        return same
          ? { kind: "replayed", counter, values: [], clampedMs: 0 }
          : { kind: "exists" };
      }
      if (
        input.counter.countdownMs !== null &&
        input.counter.kind !== "repeated_countdown"
      )
        return { kind: "invalid", code: "countdown_invalid" };
      this.#insert(input.ownerId, input.id, input.counter, input.now, null);
      return {
        kind: "applied",
        counter: this.#required(input.ownerId, input.id),
        values: [],
        clampedMs: 0,
      };
    });
  }

  update(input: {
    readonly ownerId: string;
    readonly id: string;
    readonly expectedRevision: number;
    readonly patch: CounterPatch;
    readonly now: string;
  }): CounterWriteResult {
    return this.#transaction("counter_update", () => {
      const counter = this.#live(input.ownerId, input.id);
      if (counter === undefined) return { kind: "not-found" };
      if (counter.revision !== input.expectedRevision)
        return { kind: "precondition-failed", revision: counter.revision };
      const countdownMs =
        input.patch.countdownMs === undefined
          ? counter.countdownMs
          : input.patch.countdownMs;
      if (countdownMs !== null && counter.kind !== "repeated_countdown")
        return { kind: "invalid", code: "countdown_invalid" };
      const enabled = input.patch.enabled ?? counter.enabled;
      if (!enabled && counter.runningSince !== null)
        return { kind: "invalid", code: "stopwatch_running" };
      const streak = input.patch.streak ?? counter.streak;
      this.db
        .prepare(
          `UPDATE counters SET title=?, icon=?, enabled=?, hidden=?, streak_enabled=?, streak_min_value=?,
             streak_mode=?, streak_weekdays=?, streak_weekly_frequency=?, countdown_ms=?,
             revision=revision+1, updated_at=? WHERE owner_id=? AND id=?`,
        )
        .run(
          input.patch.title ?? counter.title,
          input.patch.icon === undefined ? counter.icon : input.patch.icon,
          enabled ? 1 : 0,
          (input.patch.hidden ?? counter.hidden) ? 1 : 0,
          streak.enabled ? 1 : 0,
          streak.minValue,
          streak.mode,
          weekdayMask(streak.weekdays),
          streak.weeklyFrequency,
          countdownMs,
          input.now,
          input.ownerId,
          input.id,
        );
      return {
        kind: "applied",
        counter: this.#required(input.ownerId, input.id),
        values: [],
        clampedMs: 0,
      };
    });
  }

  /**
   * Deletes a counter and all its day values. The definition stays as a
   * tombstone so a replayed import does not bring it back.
   */
  delete(input: {
    readonly ownerId: string;
    readonly id: string;
    readonly expectedRevision: number;
    readonly now: string;
  }): CounterWriteResult {
    return this.#transaction("counter_delete", () => {
      const counter = this.#live(input.ownerId, input.id);
      if (counter === undefined) return { kind: "not-found" };
      if (counter.revision !== input.expectedRevision)
        return { kind: "precondition-failed", revision: counter.revision };
      this.db
        .prepare(
          "DELETE FROM counter_day_values WHERE owner_id=? AND counter_id=?",
        )
        .run(input.ownerId, input.id);
      this.db
        .prepare(
          `UPDATE counters SET deleted_at=?, running_since=NULL, revision=revision+1, updated_at=?
           WHERE owner_id=? AND id=?`,
        )
        .run(input.now, input.now, input.ownerId, input.id);
      return {
        kind: "applied",
        counter: this.#required(input.ownerId, input.id),
        values: [],
        clampedMs: 0,
      };
    });
  }

  /**
   * Sets or increments one day's value at the day revision the caller read
   * (0 when the day had no value). A decrement stops at zero.
   */
  recordDay(input: {
    readonly ownerId: string;
    readonly counterId: string;
    readonly day: string;
    readonly action: "set" | "increment";
    readonly amount: number;
    readonly expectedRevision: number;
    readonly timeZone: string;
    readonly now: string;
  }): CounterWriteResult {
    return this.#transaction("counter_record", () => {
      const counter = this.#live(input.ownerId, input.counterId);
      if (counter === undefined) return { kind: "not-found" };
      if (!counter.enabled)
        return { kind: "invalid", code: "counter_disabled" };
      const current = this.dayValue(input.ownerId, input.counterId, input.day);
      if ((current?.revision ?? 0) !== input.expectedRevision)
        return {
          kind: "precondition-failed",
          revision: current?.revision ?? 0,
        };
      const value =
        input.action === "set"
          ? input.amount
          : incrementedCounterValue(current?.value ?? 0, input.amount);
      const violation = validateCounterDayValue({
        kind: counter.kind,
        day: input.day,
        value,
        timeZone: input.timeZone,
      });
      if (violation !== null) return { kind: "invalid", code: violation };
      const written = this.#writeDay(
        input.ownerId,
        counter.id,
        input.day,
        value,
        input.now,
      );
      return { kind: "applied", counter, values: [written], clampedMs: 0 };
    });
  }

  /** Starts a stopwatch at the server's current instant. */
  startStopwatch(input: {
    readonly ownerId: string;
    readonly id: string;
    readonly expectedRevision: number;
    readonly now: string;
  }): CounterWriteResult {
    return this.#transaction("counter_start", () => {
      const counter = this.#live(input.ownerId, input.id);
      if (counter === undefined) return { kind: "not-found" };
      if (counter.revision !== input.expectedRevision)
        return { kind: "precondition-failed", revision: counter.revision };
      if (counter.kind !== "stopwatch")
        return { kind: "invalid", code: "not_stopwatch" };
      if (!counter.enabled)
        return { kind: "invalid", code: "counter_disabled" };
      if (counter.runningSince !== null)
        return { kind: "invalid", code: "stopwatch_running" };
      this.db
        .prepare(
          "UPDATE counters SET running_since=?, revision=revision+1, updated_at=? WHERE owner_id=? AND id=?",
        )
        .run(input.now, input.now, input.ownerId, input.id);
      return {
        kind: "applied",
        counter: this.#required(input.ownerId, input.id),
        values: [],
        clampedMs: 0,
      };
    });
  }

  /**
   * Stops a stopwatch and adds the elapsed time to each owner-zone day the
   * run covered. A day never exceeds its own length; any excess, which only
   * arises after an explicit set, is reported as clamped.
   */
  stopStopwatch(input: {
    readonly ownerId: string;
    readonly id: string;
    readonly expectedRevision: number;
    readonly timeZone: string;
    readonly now: string;
  }): CounterWriteResult {
    return this.#transaction("counter_stop", () => {
      const counter = this.#live(input.ownerId, input.id);
      if (counter === undefined) return { kind: "not-found" };
      if (counter.revision !== input.expectedRevision)
        return { kind: "precondition-failed", revision: counter.revision };
      if (counter.kind !== "stopwatch")
        return { kind: "invalid", code: "not_stopwatch" };
      if (counter.runningSince === null)
        return { kind: "invalid", code: "stopwatch_stopped" };
      const values: CounterDayValueRecord[] = [];
      let clampedMs = 0;
      for (const share of stopwatchDayShares(
        counter.runningSince,
        input.now,
        input.timeZone,
      )) {
        const before =
          this.dayValue(input.ownerId, counter.id, share.day)?.value ?? 0;
        const limit = maxCounterDayValue(
          "stopwatch",
          share.day,
          input.timeZone,
        );
        const value = Math.min(limit, before + share.ms);
        clampedMs += before + share.ms - value;
        values.push(
          this.#writeDay(
            input.ownerId,
            counter.id,
            share.day,
            value,
            input.now,
          ),
        );
      }
      this.db
        .prepare(
          "UPDATE counters SET running_since=NULL, revision=revision+1, updated_at=? WHERE owner_id=? AND id=?",
        )
        .run(input.now, input.ownerId, input.id);
      return {
        kind: "applied",
        counter: this.#required(input.ownerId, input.id),
        values,
        clampedMs,
      };
    });
  }

  getEvaluation(
    ownerId: string,
    day: string,
  ): DailyEvaluationRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM daily_evaluations WHERE owner_id=? AND day=?")
      .get(ownerId, day) as Row | undefined;
    return row === undefined ? undefined : evaluationFromRow(row);
  }

  getEvaluationById(
    ownerId: string,
    id: string,
  ): DailyEvaluationRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM daily_evaluations WHERE owner_id=? AND id=?")
      .get(ownerId, id) as Row | undefined;
    return row === undefined ? undefined : evaluationFromRow(row);
  }

  listEvaluations(
    ownerId: string,
    from: string,
    to: string,
  ): DailyEvaluationRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM daily_evaluations WHERE owner_id=? AND day BETWEEN ? AND ? ORDER BY day",
        )
        .all(ownerId, from, to) as Row[]
    ).map(evaluationFromRow);
  }

  /**
   * Creates or edits the evaluation of a day at the revision the caller read
   * (0 when the day has none). Omitted fields keep their value.
   */
  writeEvaluation(input: {
    readonly ownerId: string;
    readonly day: string;
    readonly expectedRevision: number;
    readonly patch: EvaluationPatch;
    readonly newId: () => string;
    readonly now: string;
  }): EvaluationWriteResult {
    this.db.exec("SAVEPOINT evaluation_write;");
    try {
      const current = this.getEvaluation(input.ownerId, input.day);
      let result: EvaluationWriteResult;
      if ((current?.revision ?? 0) !== input.expectedRevision)
        result = {
          kind: "precondition-failed",
          revision: current?.revision ?? 0,
        };
      else {
        const patch = input.patch;
        if (current === undefined) {
          const id = input.newId();
          this.db
            .prepare(
              `INSERT INTO daily_evaluations (id,owner_id,day,notes,reflection,impact,energy,remind_tomorrow,
                 revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)`,
            )
            .run(
              id,
              input.ownerId,
              input.day,
              patch.notes ?? "",
              patch.reflection ?? "",
              patch.impact ?? null,
              patch.energy ?? null,
              patch.remindTomorrow === true ? 1 : 0,
              input.now,
              input.now,
            );
        } else
          this.db
            .prepare(
              `UPDATE daily_evaluations SET notes=?, reflection=?, impact=?, energy=?, remind_tomorrow=?,
                 revision=revision+1, updated_at=? WHERE owner_id=? AND id=?`,
            )
            .run(
              patch.notes ?? current.notes,
              patch.reflection ?? current.reflection,
              patch.impact === undefined ? current.impact : patch.impact,
              patch.energy === undefined ? current.energy : patch.energy,
              (patch.remindTomorrow ?? current.remindTomorrow) ? 1 : 0,
              input.now,
              input.ownerId,
              current.id,
            );
        const evaluation = this.getEvaluation(input.ownerId, input.day);
        if (evaluation === undefined) throw new Error("Evaluation disappeared");
        result = { kind: "applied", evaluation };
      }
      this.db.exec("RELEASE SAVEPOINT evaluation_write;");
      return result;
    } catch (error) {
      this.db.exec(
        "ROLLBACK TO SAVEPOINT evaluation_write; RELEASE SAVEPOINT evaluation_write;",
      );
      throw error;
    }
  }

  /**
   * Import helper; runs inside the caller's transaction. A replayed identical
   * counter, day value or evaluation is kept, including later local edits of
   * it. A changed source record, or a source day that meets a value recorded
   * in Tadooer, aborts the import as a changed task does. Days of a deleted
   * counter are not recreated.
   */
  importInTransaction(
    ownerId: string,
    input: {
      readonly counters: readonly ImportedCounter[];
      readonly evaluations: readonly ImportedEvaluation[];
    },
    newId: () => string,
    now: string,
  ): CounterImportOutcome {
    let created = 0;
    let existing = 0;
    let dayValuesCreated = 0;
    let dayValuesExisting = 0;
    let evaluationsCreated = 0;
    let evaluationsExisting = 0;
    const findCounter = this.db.prepare(
      `SELECT * FROM counters WHERE owner_id=? AND source_kind='super_productivity' AND source_counter_id=?`,
    );
    const insertValue = this.db.prepare(
      `INSERT INTO counter_day_values (owner_id,counter_id,day,value,revision,updated_at,imported_value)
       VALUES (?,?,?,?,1,?,?)`,
    );
    for (const source of input.counters) {
      const priorRow = findCounter.get(ownerId, source.sourceId) as
        Row | undefined;
      let counterId: string;
      if (priorRow !== undefined) {
        if (priorRow.source_hash !== source.sourceHash)
          throw new Error("IMPORT_SOURCE_CHANGED");
        existing++;
        if (priorRow.deleted_at !== null) continue;
        counterId = String(priorRow.id);
      } else {
        counterId = newId();
        this.#insert(ownerId, counterId, source, now, source);
        created++;
      }
      for (const { day, value } of source.values) {
        const prior = this.dayValue(ownerId, counterId, day);
        if (prior === undefined) {
          insertValue.run(ownerId, counterId, day, value, now, value);
          dayValuesCreated++;
        } else if (prior.importedValue === value) dayValuesExisting++;
        else throw new Error("IMPORT_SOURCE_CHANGED");
      }
    }
    const insertEvaluation = this.db.prepare(
      `INSERT INTO daily_evaluations (id,owner_id,day,notes,reflection,impact,energy,remind_tomorrow,
         imported_focus_sessions_json,revision,created_at,updated_at,source_kind,source_hash,source_json)
       VALUES (?,?,?,?,?,?,?,?,?,1,?,?,'super_productivity',?,?)`,
    );
    for (const source of input.evaluations) {
      const prior = this.db
        .prepare(
          "SELECT source_hash FROM daily_evaluations WHERE owner_id=? AND day=?",
        )
        .get(ownerId, source.day) as Row | undefined;
      if (prior !== undefined) {
        if (prior.source_hash !== source.sourceHash)
          throw new Error("IMPORT_SOURCE_CHANGED");
        evaluationsExisting++;
        continue;
      }
      insertEvaluation.run(
        newId(),
        ownerId,
        source.day,
        source.notes,
        source.reflection,
        source.impact,
        source.energy,
        source.remindTomorrow ? 1 : 0,
        JSON.stringify(source.focusSessionsMs),
        now,
        now,
        source.sourceHash,
        source.sourceJson,
      );
      evaluationsCreated++;
    }
    return {
      created,
      existing,
      dayValuesCreated,
      dayValuesExisting,
      evaluationsCreated,
      evaluationsExisting,
    };
  }

  #insert(
    ownerId: string,
    id: string,
    counter: CounterDefinitionInput,
    now: string,
    source: Pick<
      ImportedCounter,
      "sourceId" | "sourceHash" | "sourceJson"
    > | null,
  ): void {
    const position = this.db
      .prepare(
        "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM counters WHERE owner_id=?",
      )
      .get(ownerId) as { next: number };
    this.db
      .prepare(
        `INSERT INTO counters (id,owner_id,title,kind,icon,enabled,hidden,position,streak_enabled,
           streak_min_value,streak_mode,streak_weekdays,streak_weekly_frequency,countdown_ms,
           revision,created_at,updated_at,source_kind,source_counter_id,source_hash,source_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)`,
      )
      .run(
        id,
        ownerId,
        counter.title,
        counter.kind,
        counter.icon,
        counter.enabled ? 1 : 0,
        counter.hidden ? 1 : 0,
        position.next,
        counter.streak.enabled ? 1 : 0,
        counter.streak.minValue,
        counter.streak.mode,
        weekdayMask(counter.streak.weekdays),
        counter.streak.weeklyFrequency,
        counter.countdownMs,
        now,
        now,
        source === null ? null : "super_productivity",
        source?.sourceId ?? null,
        source?.sourceHash ?? null,
        source?.sourceJson ?? null,
      );
  }

  #writeDay(
    ownerId: string,
    counterId: string,
    day: string,
    value: number,
    now: string,
  ): CounterDayValueRecord {
    this.db
      .prepare(
        `INSERT INTO counter_day_values (owner_id,counter_id,day,value,revision,updated_at)
         VALUES (?,?,?,?,1,?)
         ON CONFLICT (counter_id, day) DO UPDATE SET value=excluded.value,
           revision=counter_day_values.revision+1, updated_at=excluded.updated_at`,
      )
      .run(ownerId, counterId, day, value, now);
    const written = this.dayValue(ownerId, counterId, day);
    if (written === undefined) throw new Error("Counter day value disappeared");
    return written;
  }

  #live(ownerId: string, id: string): CounterRecord | undefined {
    const counter = this.get(ownerId, id);
    return counter?.deletedAt === null ? counter : undefined;
  }

  #required(ownerId: string, id: string): CounterRecord {
    const counter = this.get(ownerId, id);
    if (counter === undefined) throw new Error("Counter disappeared");
    return counter;
  }

  #transaction(
    name: string,
    body: () => CounterWriteResult,
  ): CounterWriteResult {
    this.db.exec(`SAVEPOINT ${name};`);
    try {
      const result = body();
      this.db.exec(`RELEASE SAVEPOINT ${name};`);
      return result;
    } catch (error) {
      this.db.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name};`);
      throw error;
    }
  }
}
