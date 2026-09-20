import { randomUUID } from "node:crypto";
import {
  createTaskRequestSchema,
  type CreateTaskRequest,
} from "@suite/contracts";
import {
  parseStructuredCapture,
  resolveCaptureReferences,
  StructuredCaptureError,
} from "@suite/domain";
import type { SuiteDatabase } from "@suite/persistence";

export const resolveTaskCapture = (
  database: SuiteDatabase,
  ownerId: string,
  input: CreateTaskRequest,
  now: string,
): CreateTaskRequest => {
  if (input.structured !== true) return input;
  const capture = parseStructuredCapture(input.title, {
    at: new Date(now),
    timezoneOffsetMinutes: 0,
    timeZone: database.getPlanningPreferences(ownerId).timeZone,
  });
  if (
    (capture.projectName !== undefined && input.projectId !== undefined) ||
    (capture.tagNames.length > 0 && input.tagIds !== undefined) ||
    (capture.deadline !== undefined && input.deadline !== undefined) ||
    (capture.plannedStart !== undefined && input.plannedStart !== undefined)
  )
    throw new StructuredCaptureError(
      "Use either capture markers or explicit fields for each task property",
    );
  const references = resolveCaptureReferences(
    capture,
    database.listProjects(ownerId),
    database
      .listTags(ownerId)
      .map((tag) => ({ ...tag, displayName: tag.title })),
  );
  const parsed = createTaskRequestSchema.safeParse({
    ...input,
    structured: false,
    title: capture.title,
    ...references,
    tagIds: capture.tagNames.length > 0 ? references.tagIds : input.tagIds,
    ...(capture.plannedStart === undefined
      ? {}
      : { plannedStart: capture.plannedStart }),
    ...(capture.deadline === undefined ? {} : { deadline: capture.deadline }),
  });
  if (!parsed.success)
    throw new StructuredCaptureError(
      "Resolved capture fields are invalid or exceed their limits",
    );
  return parsed.data;
};

export const createCapturedTask = (
  database: SuiteDatabase,
  ownerId: string,
  key: string,
  hash: string,
  input: CreateTaskRequest,
  now: string,
) =>
  database.createTaskIdempotently(
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
    },
    () => {
      const resolved = resolveTaskCapture(database, ownerId, input, now);
      return {
        title: resolved.title,
        projectId: resolved.projectId ?? null,
        tagIds: resolved.tagIds ?? [],
        plannedStart: resolved.plannedStart ?? null,
        deadlineDate:
          resolved.deadline?.kind === "date" ? resolved.deadline.value : null,
        deadlineAt:
          resolved.deadline?.kind === "instant"
            ? resolved.deadline.value
            : null,
      };
    },
  );
