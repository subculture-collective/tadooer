import { randomUUID } from "node:crypto";
import type {
  AutomationConfirmationResponse,
  AutomationPreviewCommand,
} from "@suite/contracts";
import type { SuiteDatabase } from "@suite/persistence";
import {
  choicePoolHistoryResponse,
  choicePoolItemResponse,
  choicePoolResponse,
  planningPlaceholderResponse,
  templateBlueprintResponse,
  templateResponse,
  templateSetResponse,
} from "./shared.ts";

// Assistant authoring of task templates, template sets, choice pools and
// planning placeholders (issue #57, ADR 0036). automation.ts keeps the shared
// preview/confirm protocol; this module repeats the browser validation, names
// every reference it checked and freezes the revisions the confirmation
// depends on. The store methods run inside the confirmation's receipt
// transaction, so a mutation, its outcome and its audit row commit together.

export type AuthoringCommand = Extract<
  AutomationPreviewCommand,
  {
    operation:
      | "templates.mutate"
      | "template_sets.create"
      | "pools.mutate"
      | "placeholders.create";
  }
>;

type AffectedKind =
  | "template"
  | "template_set"
  | "choice_pool"
  | "pool_item"
  | "planning_placeholder"
  | "task"
  | "project"
  | "tag";
interface Affected {
  readonly entityKind: AffectedKind;
  readonly entityId: string;
}
interface BaseRevision extends Affected {
  readonly revision: number;
}
export type AuthoringPreview =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly affected: readonly Affected[];
      readonly baseRevisions: readonly BaseRevision[];
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };
type Result = AutomationConfirmationResponse["result"];
export type AuthoringConfirmation =
  | { readonly ok: true; readonly apply: () => Result }
  | { readonly ok: false; readonly status: number; readonly message: string };

export const isAuthoringCommand = (
  command: AutomationPreviewCommand,
): command is AuthoringCommand =>
  command.operation === "templates.mutate" ||
  command.operation === "template_sets.create" ||
  command.operation === "pools.mutate" ||
  command.operation === "placeholders.create";

const quoted = (value: string): string =>
  `"${value.length > 60 ? `${value.slice(0, 57)}...` : value}"`;

const fail = (
  status: number,
  code: string,
  message: string,
): AuthoringPreview => ({ ok: false, status, code, message });
const conflict = (message: string): AuthoringPreview =>
  fail(412, "REVISION_CONFLICT", message);

const bind = (
  affected: Affected[],
  baseRevisions: BaseRevision[],
  entry: BaseRevision,
): void => {
  affected.push({ entityKind: entry.entityKind, entityId: entry.entityId });
  baseRevisions.push(entry);
};

/**
 * The suggested project and every tag of a template must be active owner
 * records; their revisions are frozen so an archive between preview and
 * confirmation is stale.
 */
const bindTemplateReferences = (
  database: SuiteDatabase,
  ownerId: string,
  references: {
    readonly suggestedProjectId: string | null;
    readonly tagIds: readonly string[];
  },
  affected: Affected[],
  baseRevisions: BaseRevision[],
): AuthoringPreview | undefined => {
  if (references.suggestedProjectId !== null) {
    const project = database
      .listProjects(ownerId)
      .find(({ id }) => id === references.suggestedProjectId);
    if (project?.archivedAt !== null)
      return fail(
        404,
        "INVALID_TEMPLATE_REFERENCES",
        "Template project is unavailable",
      );
    bind(affected, baseRevisions, {
      entityKind: "project",
      entityId: project.id,
      revision: project.revision,
    });
  }
  const tags = database.listTags(ownerId);
  for (const tagId of references.tagIds) {
    const tag = tags.find(({ id }) => id === tagId);
    if (tag?.archivedAt !== null)
      return fail(
        404,
        "INVALID_TEMPLATE_REFERENCES",
        "Template tag is unavailable",
      );
    bind(affected, baseRevisions, {
      entityKind: "tag",
      entityId: tag.id,
      revision: tag.revision,
    });
  }
  return undefined;
};

const templateBody = (
  database: SuiteDatabase,
  template: Parameters<typeof templateResponse>[0],
): Result => ({
  template: templateResponse(template),
  blueprints: database
    .listTemplateSubtaskBlueprints(template.id)
    .map(templateBlueprintResponse),
  poolSlots: [...database.listTemplatePoolSlots(template.id)],
});

const choicePoolBody = (
  database: SuiteDatabase,
  ownerId: string,
  poolId: string,
  history: readonly Parameters<typeof choicePoolHistoryResponse>[0][],
): Result => {
  const pool = database.getChoicePool(ownerId, poolId, true);
  if (pool === undefined) throw new Error("Choice pool could not be read");
  return {
    pool: choicePoolResponse(pool),
    items: database
      .listChoicePoolItems(pool.id, true)
      .map(choicePoolItemResponse),
    history: history.map(choicePoolHistoryResponse),
  };
};

const templateUpdateFields = (
  input: Extract<
    Extract<AuthoringCommand, { operation: "templates.mutate" }>["input"],
    { action: "update" }
  >,
): string[] =>
  (
    [
      "title",
      "notes",
      "estimateMinutes",
      "suggestedProjectId",
      "tagIds",
      "subtasks",
    ] as const
  ).filter((key) => key in input);

export const previewAuthoring = (
  database: SuiteDatabase,
  ownerId: string,
  command: AuthoringCommand,
): AuthoringPreview => {
  const affected: Affected[] = [];
  const baseRevisions: BaseRevision[] = [];
  const ok = (summary: string): AuthoringPreview => ({
    ok: true,
    summary,
    affected,
    baseRevisions,
  });

  if (command.operation === "templates.mutate") {
    const input = command.input;
    if (input.action === "create") {
      const problem = bindTemplateReferences(
        database,
        ownerId,
        input,
        affected,
        baseRevisions,
      );
      if (problem !== undefined) return problem;
      return ok(
        `Create the template ${quoted(input.title)} with ${String(input.subtasks.length)} subtask blueprint(s)`,
      );
    }
    if (input.action === "create_from_task") {
      const task = database.getTask(ownerId, input.taskId);
      if (task === undefined)
        return fail(404, "TASK_NOT_FOUND", "Task not found");
      if (task.revision !== input.expectedTaskRevision)
        return conflict("Source task changed; read it again");
      bind(affected, baseRevisions, {
        entityKind: "task",
        entityId: task.id,
        revision: task.revision,
      });
      return ok(
        `Create a template from the task ${quoted(task.title)} with its ${String(database.listSubtasks(ownerId, task.id).length)} subtask(s)`,
      );
    }
    const template = database.getTaskTemplate(ownerId, input.templateId);
    if (template === undefined)
      return fail(404, "TEMPLATE_NOT_FOUND", "Task template not found");
    if (template.revision !== input.expectedRevision)
      return conflict("Template changed; read the library again");
    bind(affected, baseRevisions, {
      entityKind: "template",
      entityId: template.id,
      revision: template.revision,
    });
    if (input.action === "archive")
      return ok(
        `Archive the template ${quoted(template.title)}; sets that include it can no longer be instantiated`,
      );
    if (input.action === "add_pool_slot") {
      const pool = database.getChoicePool(ownerId, input.poolId);
      if (pool === undefined)
        return fail(404, "CHOICE_POOL_NOT_FOUND", "Choice pool not found");
      if (database.listChoicePoolItems(pool.id).length < input.pickCount)
        return fail(
          409,
          "TEMPLATE_POOL_SLOT_INVALID",
          "The pool has fewer active items than the pick count",
        );
      if (
        database
          .listTemplatePoolSlots(template.id)
          .some(({ position }) => position === input.position)
      )
        return fail(
          409,
          "TEMPLATE_POOL_SLOT_INVALID",
          "The template already has a slot at that position",
        );
      bind(affected, baseRevisions, {
        entityKind: "choice_pool",
        entityId: pool.id,
        revision: pool.revision,
      });
      return ok(
        `Add a slot picking ${String(input.pickCount)} from the pool ${quoted(pool.title)} to the template ${quoted(template.title)} at position ${String(input.position + 1)}`,
      );
    }
    const problem = bindTemplateReferences(
      database,
      ownerId,
      {
        suggestedProjectId:
          "suggestedProjectId" in input
            ? (input.suggestedProjectId ?? null)
            : template.suggestedProjectId,
        tagIds: input.tagIds ?? template.tagIds,
      },
      affected,
      baseRevisions,
    );
    if (problem !== undefined) return problem;
    return ok(
      `Update ${templateUpdateFields(input).join(", ")} of the template ${quoted(template.title)}`,
    );
  }

  if (command.operation === "template_sets.create") {
    const titles: string[] = [];
    for (const templateId of command.input.templateIds) {
      const template = database.getTaskTemplate(ownerId, templateId);
      if (template === undefined)
        return fail(
          409,
          "INVALID_TEMPLATE_SET_MEMBERS",
          "Template set members must be active owner templates",
        );
      bind(affected, baseRevisions, {
        entityKind: "template",
        entityId: template.id,
        revision: template.revision,
      });
      titles.push(quoted(template.title));
    }
    return ok(
      `Create the template set ${quoted(command.input.title)} from ${titles.join(", ")}`,
    );
  }

  if (command.operation === "pools.mutate") {
    const input = command.input;
    if (input.action === "create") {
      if (input.items.length < input.pickCount)
        return fail(
          400,
          "INVALID_CHOICE_POOL",
          "Choice pool has too few items for its pick count",
        );
      return ok(
        `Create the ${input.policy} pool ${quoted(input.title)} picking ${String(input.pickCount)} of ${String(input.items.length)} item(s)`,
      );
    }
    const pool = database.getChoicePool(ownerId, input.poolId);
    if (pool === undefined)
      return fail(404, "CHOICE_POOL_NOT_FOUND", "Choice pool not found");
    bind(affected, baseRevisions, {
      entityKind: "choice_pool",
      entityId: pool.id,
      revision: pool.revision,
    });
    const items = database.listChoicePoolItems(pool.id, true);
    if (input.action === "update") {
      if (pool.revision !== input.expectedRevision)
        return conflict("Choice pool changed; read the library again");
      if (input.items.length < input.pickCount)
        return fail(
          400,
          "INVALID_CHOICE_POOL",
          "Choice pool has too few items for its pick count",
        );
      for (const kept of input.items) {
        if (kept.id === undefined) continue;
        const item = items.find(({ id }) => id === kept.id);
        if (item === undefined)
          return fail(404, "POOL_ITEM_NOT_FOUND", "Choice pool item not found");
        bind(affected, baseRevisions, {
          entityKind: "pool_item",
          entityId: item.id,
          revision: item.revision,
        });
      }
      const dropped = items.filter(
        (item) =>
          item.archivedAt === null &&
          !input.items.some(
            (kept) => kept.id === item.id || kept.title === item.title,
          ),
      ).length;
      return ok(
        `Replace the ${pool.policy} pool ${quoted(pool.title)} with ${quoted(input.title)} (${input.policy}, picking ${String(input.pickCount)} of ${String(input.items.length)} item(s)); ${String(dropped)} current item(s) are archived`,
      );
    }
    const item = items.find(({ id }) => id === input.itemId);
    if (item === undefined)
      return fail(404, "POOL_ITEM_NOT_FOUND", "Choice pool item not found");
    bind(affected, baseRevisions, {
      entityKind: "pool_item",
      entityId: item.id,
      revision: item.revision,
    });
    if (input.placeholderId !== null) {
      const placeholder = database.getPlanningPlaceholder(
        ownerId,
        input.placeholderId,
      );
      if (placeholder?.poolId !== pool.id)
        return fail(
          404,
          "PLANNING_PLACEHOLDER_NOT_FOUND",
          "Placeholder not found for this pool",
        );
      bind(affected, baseRevisions, {
        entityKind: "planning_placeholder",
        entityId: placeholder.id,
        revision: placeholder.revision,
      });
    }
    return ok(
      `Record that ${quoted(item.title)} from the pool ${quoted(pool.title)} was completed at ${input.occurredAt}`,
    );
  }

  const input = command.input;
  const task = database.getTask(ownerId, input.taskId);
  if (task === undefined) return fail(404, "TASK_NOT_FOUND", "Task not found");
  const pool = database.getChoicePool(ownerId, input.poolId);
  if (pool === undefined)
    return fail(404, "CHOICE_POOL_NOT_FOUND", "Choice pool not found");
  const pickCount = input.pickCount ?? pool.pickCount;
  if (database.listChoicePoolItems(pool.id).length < pickCount)
    return fail(
      409,
      "PLACEHOLDER_RESOURCE_INVALID",
      "The pool has fewer active items than the pick count",
    );
  bind(affected, baseRevisions, {
    entityKind: "task",
    entityId: task.id,
    revision: task.revision,
  });
  bind(affected, baseRevisions, {
    entityKind: "choice_pool",
    entityId: pool.id,
    revision: pool.revision,
  });
  return ok(
    `Attach a placeholder picking ${String(pickCount)} from the pool ${quoted(pool.title)} to the task ${quoted(task.title)}`,
  );
};

/**
 * Confirmation repeats the preview checks and returns the mutation to run
 * inside the receipt transaction. A store method returning nothing there
 * means a record changed after the checks; the transaction rolls back.
 */
export const confirmAuthoring = (
  database: SuiteDatabase,
  ownerId: string,
  command: AuthoringCommand,
  now: () => string,
): AuthoringConfirmation => {
  const current = previewAuthoring(database, ownerId, command);
  if (!current.ok)
    return { ok: false, status: current.status, message: current.message };
  const changed = (what: string): never => {
    throw new Error(`${what} changed during confirmation`);
  };

  if (command.operation === "templates.mutate") {
    const input = command.input;
    if (input.action === "create")
      return {
        ok: true,
        apply: () => {
          const at = now();
          const template = database.createTaskTemplate({
            id: randomUUID(),
            ownerId,
            title: input.title,
            notes: input.notes,
            estimateMinutes: input.estimateMinutes,
            suggestedProjectId: input.suggestedProjectId,
            tagIds: input.tagIds,
            revision: 1,
            createdAt: at,
            updatedAt: at,
            archivedAt: null,
            blueprints: input.subtasks.map((subtask, position) => ({
              id: randomUUID(),
              title: subtask.title,
              position,
              revision: 1,
              createdAt: at,
              updatedAt: at,
            })),
          });
          return templateBody(database, template);
        },
      };
    if (input.action === "create_from_task")
      return {
        ok: true,
        apply: () => {
          const at = now();
          const task = database.getTask(ownerId, input.taskId);
          if (task === undefined) return changed("Source task");
          const template = database.createTaskTemplateFromTask(
            ownerId,
            task.id,
            {
              id: randomUUID(),
              ownerId,
              title: task.title,
              notes: task.notes,
              estimateMinutes: task.estimateMinutes,
              suggestedProjectId: task.projectId ?? null,
              revision: 1,
              createdAt: at,
              updatedAt: at,
              archivedAt: null,
              blueprints: database
                .listSubtasks(ownerId, task.id)
                .map((subtask, position) => ({
                  id: randomUUID(),
                  title: subtask.title,
                  position,
                  revision: 1,
                  createdAt: at,
                  updatedAt: at,
                })),
            },
          );
          if (template === undefined) return changed("Source task");
          return templateBody(database, template);
        },
      };
    if (input.action === "archive")
      return {
        ok: true,
        apply: () => {
          const template = database.archiveTaskTemplate(
            ownerId,
            input.templateId,
            input.expectedRevision,
            now(),
          );
          if (template === undefined) return changed("Template");
          return templateBody(database, template);
        },
      };
    if (input.action === "add_pool_slot")
      return {
        ok: true,
        apply: () => {
          const slot = database.createTemplatePoolSlot(ownerId, {
            id: randomUUID(),
            templateId: input.templateId,
            poolId: input.poolId,
            pickCount: input.pickCount,
            position: input.position,
            createdAt: now(),
          });
          const template = database.getTaskTemplate(ownerId, input.templateId);
          if (slot === undefined || template === undefined)
            return changed("Template or pool");
          return templateBody(database, template);
        },
      };
    return {
      ok: true,
      apply: () => {
        const at = now();
        const template = database.getTaskTemplate(ownerId, input.templateId);
        if (template === undefined) return changed("Template");
        const blueprints = database.listTemplateSubtaskBlueprints(template.id);
        const updated = database.updateTaskTemplate({
          ownerId,
          id: template.id,
          expectedRevision: input.expectedRevision,
          title: input.title ?? template.title,
          notes: input.notes ?? template.notes,
          estimateMinutes:
            "estimateMinutes" in input
              ? (input.estimateMinutes ?? null)
              : template.estimateMinutes,
          suggestedProjectId:
            "suggestedProjectId" in input
              ? (input.suggestedProjectId ?? null)
              : template.suggestedProjectId,
          tagIds: input.tagIds ?? template.tagIds,
          blueprints:
            input.subtasks === undefined
              ? blueprints.map((blueprint) => ({
                  id: blueprint.id,
                  title: blueprint.title,
                  position: blueprint.position,
                  revision: blueprint.revision,
                  createdAt: blueprint.createdAt,
                  updatedAt: blueprint.updatedAt,
                }))
              : input.subtasks.map((subtask, position) => ({
                  id: randomUUID(),
                  title: subtask.title,
                  position,
                  revision: 1,
                  createdAt: at,
                  updatedAt: at,
                })),
          now: at,
        });
        if (updated === undefined) return changed("Template");
        return templateBody(database, updated);
      },
    };
  }

  if (command.operation === "template_sets.create") {
    const input = command.input;
    return {
      ok: true,
      apply: () => {
        const at = now();
        const set = {
          id: randomUUID(),
          ownerId,
          title: input.title,
          revision: 1,
          createdAt: at,
          updatedAt: at,
          archivedAt: null,
        };
        const members = input.templateIds.map((templateId, position) => ({
          setId: set.id,
          templateId,
          position,
        }));
        database.createTemplateSet(set, members);
        return { set: templateSetResponse(set), members };
      },
    };
  }

  if (command.operation === "pools.mutate") {
    const input = command.input;
    if (input.action === "create")
      return {
        ok: true,
        apply: () => {
          const at = now();
          const poolId = randomUUID();
          const pool = database.createChoicePool(
            {
              id: poolId,
              ownerId,
              title: input.title,
              policy: input.policy,
              pickCount: input.pickCount,
              cooldownSeconds: input.cooldownSeconds,
              revision: 1,
              createdAt: at,
              updatedAt: at,
              archivedAt: null,
            },
            input.items.map(({ title }, position) => ({
              id: randomUUID(),
              poolId,
              title,
              position,
              revision: 1,
              createdAt: at,
              updatedAt: at,
              archivedAt: null,
            })),
          );
          return choicePoolBody(database, ownerId, pool.id, []);
        },
      };
    if (input.action === "update")
      return {
        ok: true,
        apply: () => {
          const updated = database.updateChoicePool({
            ownerId,
            id: input.poolId,
            expectedRevision: input.expectedRevision,
            title: input.title,
            policy: input.policy,
            pickCount: input.pickCount,
            cooldownSeconds: input.cooldownSeconds,
            items: input.items.map((item) => ({
              title: item.title,
              ...(item.id === undefined ? {} : { id: item.id }),
            })),
            now: now(),
          });
          if (updated === undefined) return changed("Choice pool");
          return choicePoolBody(database, ownerId, updated.id, []);
        },
      };
    return {
      ok: true,
      apply: () => {
        const event = database.recordChoicePoolCompletion({
          ownerId,
          poolId: input.poolId,
          itemId: input.itemId,
          placeholderId: input.placeholderId,
          occurredAt: input.occurredAt,
        });
        if (event === undefined) return changed("Choice pool item");
        return choicePoolBody(database, ownerId, input.poolId, [event]);
      },
    };
  }

  const input = command.input;
  return {
    ok: true,
    apply: () => {
      const at = now();
      const pool = database.getChoicePool(ownerId, input.poolId);
      if (pool === undefined) return changed("Choice pool");
      const placeholder = database.createPlanningPlaceholder({
        id: randomUUID(),
        ownerId,
        taskId: input.taskId,
        poolId: pool.id,
        pickCount: input.pickCount ?? pool.pickCount,
        position: database
          .listPlanningPlaceholders(ownerId)
          .filter(({ taskId }) => taskId === input.taskId).length,
        state: "unresolved",
        revision: 1,
        createdAt: at,
        updatedAt: at,
        resolvedAt: null,
      });
      if (placeholder === undefined) return changed("Task or pool");
      return { placeholder: planningPlaceholderResponse(placeholder) };
    },
  };
};
