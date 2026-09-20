import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  habitCommandSchema,
  habitSchema,
  habitOccurrenceSchema,
  type HabitCommand,
  type Habit,
  type HabitOccurrence,
} from "@suite/contracts";
import { habitDateAt, habitDueOn } from "@suite/domain";

export type HabitMutationResult =
  | {
      readonly kind: "applied" | "replayed";
      readonly habit: Habit;
      readonly occurrence: HabitOccurrence | null;
    }
  | { readonly kind: "conflict"; readonly habit: Habit }
  | { readonly kind: "invalid" }
  | { readonly kind: "idempotency-conflict" };

export class SqliteHabitStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly append: (
      ownerId: string,
      kind: string,
      id: string,
      revision: number,
      now: string,
    ) => void,
  ) {}

  list(ownerId: string): Habit[] {
    const rows = this.db
      .prepare("SELECT * FROM habits WHERE owner_id=? ORDER BY created_at,id")
      .all(ownerId) as unknown as Record<string, unknown>[];
    return rows.map((row) =>
      habitSchema.parse({
        id: row.id,
        ownerId: row.owner_id,
        title: row.title,
        cadence: JSON.parse(String(row.cadence_json)) as unknown,
        startedOn: row.started_on,
        timeZone: row.time_zone,
        revision: row.revision,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        archivedAt: row.archived_at,
      }),
    );
  }

  occurrences(ownerId: string): HabitOccurrence[] {
    const rows = this.db
      .prepare(
        "SELECT o.* FROM habit_occurrences o JOIN habits h ON h.id=o.habit_id WHERE h.owner_id=? ORDER BY o.period_key,o.id",
      )
      .all(ownerId) as unknown as Record<string, unknown>[];
    return rows.map((row) =>
      habitOccurrenceSchema.parse({
        id: row.id,
        habitId: row.habit_id,
        periodKey: row.period_key,
        completedAt: row.completed_at,
        createdAt: row.created_at,
      }),
    );
  }

  apply(input: {
    readonly ownerId: string;
    readonly actorId: string;
    readonly operationId: string;
    readonly requestHash?: string;
    readonly syncClientId?: string;
    readonly command: HabitCommand;
    readonly now: string;
  }): HabitMutationResult {
    const command = habitCommandSchema.parse(input.command);
    if (
      this.db
        .prepare("SELECT 1 FROM owner_accounts WHERE id=?")
        .get(input.ownerId) === undefined
    )
      return { kind: "invalid" };
    const hash =
      input.requestHash ??
      createHash("sha256").update(JSON.stringify(command)).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db
        .prepare(
          "SELECT request_hash,response_json FROM habit_operation_outcomes WHERE owner_id=? AND actor_id=? AND operation_id=?",
        )
        .get(input.ownerId, input.actorId, input.operationId) as
        { request_hash: string; response_json: string } | undefined;
      if (prior !== undefined) {
        this.db.exec("COMMIT");
        if (prior.request_hash !== hash)
          return { kind: "idempotency-conflict" };
        const result = JSON.parse(prior.response_json) as HabitMutationResult;
        return result.kind === "applied"
          ? { ...result, kind: "replayed" }
          : result;
      }
      if (
        input.syncClientId !== undefined &&
        this.db
          .prepare(
            "SELECT 1 FROM sync_operation_outcomes WHERE owner_id=? AND client_id=? AND operation_id=?",
          )
          .get(input.ownerId, input.syncClientId, input.operationId) !==
          undefined
      ) {
        this.db.exec("COMMIT");
        return { kind: "idempotency-conflict" };
      }
      const result = this.mutate(
        input.ownerId,
        input.operationId,
        command,
        input.now,
      );
      this.db
        .prepare(
          "INSERT INTO habit_operation_outcomes (owner_id,actor_id,operation_id,request_hash,response_json) VALUES (?,?,?,?,?)",
        )
        .run(
          input.ownerId,
          input.actorId,
          input.operationId,
          hash,
          JSON.stringify(result),
        );
      if (input.syncClientId !== undefined) {
        const entity =
          result.kind === "applied" || result.kind === "replayed"
            ? (result.occurrence ?? result.habit)
            : result.kind === "conflict"
              ? result.habit
              : undefined;
        this.db
          .prepare(
            "INSERT INTO sync_operation_outcomes (owner_id,client_id,operation_id,request_hash,state,entity_id,revision,created_at) VALUES (?,?,?,?,?,?,?,?)",
          )
          .run(
            input.ownerId,
            input.syncClientId,
            input.operationId,
            hash,
            result.kind === "conflict"
              ? "conflict"
              : entity === undefined
                ? "invalid"
                : "applied",
            entity?.id ?? null,
            entity === undefined
              ? null
              : "revision" in entity
                ? entity.revision
                : 1,
            input.now,
          );
      }
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private mutate(
    ownerId: string,
    operationId: string,
    command: HabitCommand,
    now: string,
  ): HabitMutationResult {
    if (command.kind === "habit.create") {
      if (
        this.db
          .prepare("SELECT 1 FROM habits WHERE id=?")
          .get(command.habit.id) !== undefined
      )
        return { kind: "invalid" };
      const habit: Habit = {
        ...command.habit,
        ownerId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      };
      this.db
        .prepare(
          "INSERT INTO habits (id,owner_id,title,cadence_json,started_on,time_zone,revision,created_at,updated_at,archived_at) VALUES (?,?,?,?,?,?,1,?,?,NULL)",
        )
        .run(
          habit.id,
          ownerId,
          habit.title,
          JSON.stringify(habit.cadence),
          habit.startedOn,
          habit.timeZone,
          now,
          now,
        );
      this.append(ownerId, "habit", habit.id, 1, now);
      return { kind: "applied", habit, occurrence: null };
    }
    const habit = this.list(ownerId).find(({ id }) => id === command.habitId);
    if (habit === undefined) return { kind: "invalid" };
    if (command.kind === "habit.complete") {
      const existing = this.occurrences(ownerId).find(
        ({ habitId, periodKey }) =>
          habitId === habit.id && periodKey === command.periodKey,
      );
      if (existing !== undefined)
        return { kind: "applied", habit, occurrence: existing };
    }
    if (habit.revision !== command.baseRevision)
      return { kind: "conflict", habit };
    if (command.kind === "habit.complete") {
      if (
        habit.archivedAt !== null ||
        command.periodKey > habitDateAt(now, habit.timeZone) ||
        !habitDueOn(habit, command.periodKey)
      )
        return { kind: "invalid" };
      if (
        this.db
          .prepare("SELECT 1 FROM habit_occurrences WHERE id=?")
          .get(operationId) !== undefined
      )
        return { kind: "invalid" };
      const occurrence: HabitOccurrence = {
        id: operationId,
        habitId: habit.id,
        periodKey: command.periodKey,
        completedAt: now,
        createdAt: now,
      };
      this.db
        .prepare(
          "INSERT INTO habit_occurrences (id,habit_id,period_key,completed_at,created_at) VALUES (?,?,?,?,?)",
        )
        .run(occurrence.id, habit.id, occurrence.periodKey, now, now);
      this.append(ownerId, "habit_occurrence", occurrence.id, 1, now);
      return { kind: "applied", habit, occurrence };
    }
    if (habit.archivedAt !== null && command.kind === "habit.patch")
      return { kind: "invalid" };
    const next: Habit = {
      ...habit,
      ...(command.kind === "habit.patch" && command.fields.title !== undefined
        ? { title: command.fields.title }
        : {}),
      archivedAt:
        command.kind === "habit.archive"
          ? now
          : command.kind === "habit.restore"
            ? null
            : habit.archivedAt,
      revision: habit.revision + 1,
      updatedAt: now,
    };
    this.db
      .prepare(
        "UPDATE habits SET title=?,archived_at=?,revision=?,updated_at=? WHERE owner_id=? AND id=?",
      )
      .run(next.title, next.archivedAt, next.revision, now, ownerId, habit.id);
    this.append(ownerId, "habit", habit.id, next.revision, now);
    return { kind: "applied", habit: next, occurrence: null };
  }
}
