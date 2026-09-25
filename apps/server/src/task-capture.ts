import { randomUUID } from "node:crypto";
import {
  createTaskRequestSchema,
  plannedDayAndStartMessage,
  type CreateTaskRequest,
  type RecurrenceRuleInput,
  type TaskBatchCreateRequest,
} from "@suite/contracts";
import { deadlineReminderRequiresTimeMessage } from "./task-planning.ts";
import {
  normalizeCaptureName,
  parseStructuredCapture,
  resolveCaptureReferences,
  StructuredCaptureError,
  zonedStartInstant,
  type RecurrenceRule,
} from "@suite/domain";
import type { SuiteDatabase, TaskRecord } from "@suite/persistence";
import { storedRule } from "./routes/recurrence.ts";

/** Date-only plans and reminders must stay consistent after capture (ADR 0020). */
const validatePlanning = (input: CreateTaskRequest): CreateTaskRequest => {
  if (input.plannedStart != null && input.plannedDay != null)
    throw new StructuredCaptureError(plannedDayAndStartMessage);
  if (input.deadlineReminder != null && input.deadline?.kind !== "instant")
    throw new StructuredCaptureError(deadlineReminderRequiresTimeMessage);
  return input;
};

export interface CaptureResolutionOptions {
  /**
   * Report unknown `#tags` as new tags to create. The automation path sets
   * this: its preview lists the tags and confirmation is the consent. The
   * session API instead requires `createTags: true` in the request.
   */
  readonly allowNewTags?: boolean | undefined;
  /** Tags promised by earlier items of the same batch preview. */
  readonly pendingTags?:
    readonly { readonly id: string; readonly title: string }[] | undefined;
}

const contractRule = (rule: RecurrenceRule): RecurrenceRuleInput => {
  switch (rule.cycle) {
    case "weekly":
      return {
        cycle: "weekly",
        interval: rule.interval,
        weekdays: [...rule.weekdays],
      };
    case "monthly":
      return {
        cycle: "monthly",
        interval: rule.interval,
        monthly: rule.monthly ?? { kind: "day_of_month" },
      };
    default:
      return { cycle: rule.cycle, interval: rule.interval };
  }
};

const resolveCaptureFields = (
  database: SuiteDatabase,
  ownerId: string,
  input: CreateTaskRequest,
  now: string,
  options: CaptureResolutionOptions,
): CreateTaskRequest => {
  if (input.structured !== true) return input;
  const preferences = database.getPlanningPreferences(ownerId);
  const capture = parseStructuredCapture(
    input.title,
    {
      at: new Date(now),
      timezoneOffsetMinutes: 0,
      timeZone: preferences.timeZone,
    },
    { urlBehavior: database.capture.getPreferences(ownerId).urlBehavior },
  );
  const explicit = (value: unknown) => value !== undefined && value !== null;
  if (
    (capture.projectName !== undefined && input.projectId !== undefined) ||
    (capture.tagNames.length > 0 &&
      (input.tagIds !== undefined || input.newTags !== undefined)) ||
    (capture.deadline !== undefined && input.deadline !== undefined) ||
    ((capture.plannedStart !== undefined ||
      capture.plannedDay !== undefined ||
      capture.recurrence !== undefined) &&
      (explicit(input.plannedStart) || explicit(input.plannedDay))) ||
    (capture.estimateMinutes !== undefined &&
      explicit(input.estimateMinutes)) ||
    (capture.recurrence !== undefined && input.recurrence !== undefined) ||
    (capture.links.length > 0 && input.attachments !== undefined)
  )
    throw new StructuredCaptureError(
      "Use either capture markers or explicit fields for each task property",
    );
  const references = resolveCaptureReferences(
    capture,
    database.listProjects(ownerId),
    [
      ...database
        .listTags(ownerId)
        .map((tag) => ({ ...tag, displayName: tag.title })),
      ...(options.pendingTags ?? []).map((tag) => ({
        id: tag.id,
        displayName: tag.title,
        archivedAt: null,
      })),
    ],
    {
      allowNewTags: options.allowNewTags === true || input.createTags === true,
    },
  );
  const recurrence = capture.recurrence;
  const seriesStart =
    recurrence === undefined
      ? {}
      : recurrence.startTime === null
        ? { plannedDay: recurrence.startDate }
        : {
            plannedStart: zonedStartInstant(
              recurrence.startDate,
              recurrence.startTime,
              preferences.timeZone,
            ),
          };
  const parsed = createTaskRequestSchema.safeParse({
    ...input,
    structured: false,
    createTags: undefined,
    title: capture.title,
    ...references,
    newTags:
      references.newTags.length === 0
        ? input.newTags
        : references.newTags.map((title) => ({ id: randomUUID(), title })),
    tagIds: capture.tagNames.length > 0 ? references.tagIds : input.tagIds,
    ...(capture.plannedStart === undefined
      ? {}
      : { plannedStart: capture.plannedStart }),
    ...(capture.plannedDay === undefined
      ? {}
      : { plannedDay: capture.plannedDay }),
    ...seriesStart,
    ...(capture.deadline === undefined ? {} : { deadline: capture.deadline }),
    ...(capture.estimateMinutes === undefined
      ? {}
      : { estimateMinutes: capture.estimateMinutes }),
    ...(capture.links.length === 0 ? {} : { attachments: capture.links }),
    ...(recurrence === undefined
      ? {}
      : {
          recurrence: {
            rule: contractRule(recurrence.rule),
            startDate: recurrence.startDate,
            startTime: recurrence.startTime,
          },
        }),
  });
  if (!parsed.success)
    throw new StructuredCaptureError(
      "Resolved capture fields are invalid or exceed their limits",
    );
  return parsed.data;
};

export const resolveTaskCapture = (
  database: SuiteDatabase,
  ownerId: string,
  input: CreateTaskRequest,
  now: string,
  options: CaptureResolutionOptions = {},
): CreateTaskRequest =>
  validatePlanning(
    resolveCaptureFields(database, ownerId, input, now, options),
  );

/**
 * Creates the promised tags inside the capture savepoint. A tag whose
 * case-folded name appeared since the preview is reused; an archived one
 * fails, as it would have at preview.
 */
const createNewTags = (
  database: SuiteDatabase,
  ownerId: string,
  newTags: readonly { readonly id: string; readonly title: string }[],
  now: string,
): string[] => {
  const ids: string[] = [];
  for (const tag of newTags) {
    const existing = database
      .listTags(ownerId)
      .find(
        (candidate) =>
          normalizeCaptureName(candidate.title) ===
          normalizeCaptureName(tag.title),
      );
    if (existing !== undefined) {
      if (existing.archivedAt !== null)
        throw new StructuredCaptureError(
          `Tag “${tag.title}” is archived; restore it before capturing with it`,
        );
      ids.push(existing.id);
      continue;
    }
    const created = database.mutateOrganization(
      "tag",
      ownerId,
      tag.id,
      null,
      { title: tag.title },
      now,
    );
    if (created === undefined)
      throw new StructuredCaptureError(
        `Tag “${tag.title}” could not be created`,
      );
    ids.push(created.id);
  }
  return ids;
};

export type CapturedTaskResult =
  | { readonly kind: "created" | "replayed"; readonly task: TaskRecord }
  | { readonly kind: "conflict" };

/**
 * One atomic capture: the task, any new tags, link attachments and a
 * recurring series started from the task commit or roll back together.
 * Replays return the original task and create nothing else.
 */
export const createCapturedTask = (
  database: SuiteDatabase,
  ownerId: string,
  key: string,
  hash: string,
  input: CreateTaskRequest,
  now: string,
  options: CaptureResolutionOptions = {},
): CapturedTaskResult =>
  database.capture.atomically(() => {
    let resolved: CreateTaskRequest | undefined;
    const created = database.createTaskIdempotently(
      ownerId,
      key,
      hash,
      {
        id: randomUUID(),
        title: input.title,
        notes: input.notes,
        status: "open",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        estimateMinutes: input.estimateMinutes ?? null,
        startReminder: input.startReminder ?? { kind: "default" },
        deadlineReminderMinutes: input.deadlineReminder?.minutes ?? null,
      },
      () => {
        resolved = resolveTaskCapture(database, ownerId, input, now, options);
        const createdTagIds = createNewTags(
          database,
          ownerId,
          resolved.newTags ?? [],
          now,
        );
        return {
          title: resolved.title,
          projectId: resolved.projectId ?? null,
          tagIds: [...new Set([...(resolved.tagIds ?? []), ...createdTagIds])],
          plannedStart: resolved.plannedStart ?? null,
          plannedDay: resolved.plannedDay ?? null,
          deadlineDate:
            resolved.deadline?.kind === "date" ? resolved.deadline.value : null,
          deadlineAt:
            resolved.deadline?.kind === "instant"
              ? resolved.deadline.value
              : null,
          estimateMinutes: resolved.estimateMinutes ?? null,
        };
      },
    );
    if (created.kind !== "created" || resolved === undefined) return created;
    for (const link of resolved.attachments ?? []) {
      const attached = database.taskLinks.createAttachment(
        ownerId,
        created.task.id,
        randomUUID(),
        { kind: "link", title: link.title, url: link.url },
        now,
      );
      if (attached.kind !== "applied")
        throw new StructuredCaptureError(
          `Link “${link.url}” could not be attached (${attached.kind})`,
        );
    }
    if (resolved.recurrence !== undefined) {
      const series = database.recurrence.create({
        ownerId,
        id: randomUUID(),
        idempotencyKey: `task.create:${key}`,
        requestHash: hash,
        fields: {
          title: created.task.title,
          notes: created.task.notes,
          projectId: created.task.projectId ?? null,
          tagIds: created.task.tagIds ?? [],
          estimateMinutes: created.task.estimateMinutes ?? null,
          rule: storedRule(resolved.recurrence.rule),
          startDate: resolved.recurrence.startDate,
          endDate: null,
          startTime: resolved.recurrence.startTime,
          startReminder: { kind: "default" },
          anchor: "schedule",
          waitForCompletion: false,
          missedOccurrences: "latest",
          childTemplates: [],
        },
        sourceTaskId: created.task.id,
        timeZone: database.getPlanningPreferences(ownerId).timeZone,
        now,
      });
      if (series.kind !== "created")
        throw new StructuredCaptureError(
          `The recurring series could not be started (${series.kind === "invalid" ? series.code : series.kind})`,
        );
      const linked = database.getTask(ownerId, created.task.id);
      if (linked !== undefined) return { kind: "created", task: linked };
    }
    return created;
  });

export interface CapturedBatchResult {
  readonly kind: "created" | "replayed" | "conflict";
  readonly tasks: readonly TaskRecord[];
}

type ParsedBatch = Omit<TaskBatchCreateRequest, "items"> & {
  readonly items: readonly (CreateTaskRequest & {
    readonly children: readonly CreateTaskRequest[];
  })[];
};

class BatchConflict extends Error {}

/**
 * Several captured tasks in one savepoint (ADR 0031 paste). Item keys derive
 * from the batch key so a retry replays every task; a hierarchy violation or
 * capture error rolls the whole batch back.
 */
export const createCapturedTaskBatch = (
  database: SuiteDatabase,
  ownerId: string,
  key: string,
  hash: string,
  input: ParsedBatch,
  now: string,
  options: CaptureResolutionOptions = {},
): CapturedBatchResult => {
  try {
    return database.capture.atomically(() => {
      const tasks: TaskRecord[] = [];
      let replayed = false;
      const consent = input.createTags === true;
      const one = (
        itemKey: string,
        item: CreateTaskRequest,
      ): CapturedTaskResult => {
        const result = createCapturedTask(
          database,
          ownerId,
          itemKey,
          hash,
          consent ? { ...item, createTags: true } : item,
          now,
          options,
        );
        if (result.kind === "conflict") throw new BatchConflict();
        replayed ||= result.kind === "replayed";
        return result;
      };
      input.items.forEach(({ children, ...item }, index) => {
        const parent = one(`${key}:${String(index)}`, item);
        if (parent.kind === "conflict") return;
        tasks.push(parent.task);
        children.forEach((child, childIndex) => {
          const created = database.taskHierarchy.createChild({
            ownerId,
            parentId: parent.task.id,
            index: null,
            now,
            create: () =>
              one(`${key}:${String(index)}:${String(childIndex)}`, child),
          });
          if (created.kind === "invalid")
            throw new StructuredCaptureError(
              `Child task could not be created (${created.code})`,
            );
          if (created.kind === "created" || created.kind === "replayed")
            tasks.push(created.task);
        });
      });
      return { kind: replayed ? "replayed" : "created", tasks };
    });
  } catch (error) {
    if (error instanceof BatchConflict) return { kind: "conflict", tasks: [] };
    throw error;
  }
};
