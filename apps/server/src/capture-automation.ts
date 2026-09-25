import type {
  AutomationPreviewCommand,
  CreateTaskRequest,
} from "@suite/contracts";
import type { SuiteDatabase } from "@suite/persistence";
import {
  createCapturedTaskBatch,
  resolveTaskCapture,
  type CaptureResolutionOptions,
} from "./task-capture.ts";
import { taskResponse } from "./routes/shared.ts";

// Assistant capture (issue #90, ADR 0031). automation.ts keeps the shared
// preview/confirm protocol; this module resolves capture syntax at preview
// time so the stored command already names every tag it will create.

export type CaptureBatchCommand = Extract<
  AutomationPreviewCommand,
  { operation: "tasks.create_many" }
>;

export const isCaptureBatchCommand = (
  command: AutomationPreviewCommand,
): command is CaptureBatchCommand => command.operation === "tasks.create_many";

export interface CaptureAffected {
  readonly entityKind: "tag";
  readonly entityId: string;
}

const quoted = (value: string): string =>
  `"${value.length > 60 ? `${value.slice(0, 57)}...` : value}"`;

/** New tags are listed as affected objects; they exist only after confirmation. */
export const captureAffected = (
  input: Pick<CreateTaskRequest, "newTags">,
): CaptureAffected[] =>
  (input.newTags ?? []).map((tag) => ({
    entityKind: "tag",
    entityId: tag.id,
  }));

const extras = (input: CreateTaskRequest): string[] => {
  const parts: string[] = [];
  const tags = input.newTags ?? [];
  if (tags.length > 0)
    parts.push(
      `creates ${tags.length === 1 ? "tag" : "tags"} ${tags
        .map((tag) => quoted(tag.title))
        .join(", ")}`,
    );
  const links = input.attachments ?? [];
  if (links.length > 0)
    parts.push(
      `attaches ${String(links.length)} ${links.length === 1 ? "link" : "links"}`,
    );
  if (input.recurrence !== undefined)
    parts.push(
      `starts a ${input.recurrence.rule.cycle} recurring series from ${input.recurrence.startDate}`,
    );
  if (input.estimateMinutes != null)
    parts.push(`estimate ${String(input.estimateMinutes)} min`);
  if (input.plannedDay != null) parts.push(`planned for ${input.plannedDay}`);
  return parts;
};

export const captureSummary = (input: CreateTaskRequest): string => {
  const detail = extras(input);
  return `Create task ${quoted(input.title)}${
    detail.length === 0 ? "" : `; ${detail.join("; ")}`
  }`;
};

export interface CaptureBatchPreview {
  readonly input: CaptureBatchCommand["input"];
  readonly affected: CaptureAffected[];
  readonly summary: string;
}

/**
 * Resolves every item at preview time. Tags promised by an earlier item are
 * visible to later ones, so one name yields one tag across the batch.
 */
export const previewCaptureBatch = (
  database: SuiteDatabase,
  ownerId: string,
  command: CaptureBatchCommand,
  now: string,
): CaptureBatchPreview => {
  const pending: { id: string; title: string }[] = [];
  const consent = command.input.createTags === true;
  const resolve = (item: CreateTaskRequest): CreateTaskRequest => {
    const options: CaptureResolutionOptions = {
      allowNewTags: true,
      pendingTags: pending,
    };
    const resolved = resolveTaskCapture(
      database,
      ownerId,
      consent ? { ...item, createTags: true } : item,
      now,
      options,
    );
    pending.push(...(resolved.newTags ?? []));
    return resolved;
  };
  const items = command.input.items.map(({ children, ...item }) => ({
    ...resolve(item),
    children: children.map(resolve),
  }));
  const affected = [
    ...new Map(
      items
        .flatMap((item) => [item, ...item.children])
        .flatMap(captureAffected)
        .map((entry) => [entry.entityId, entry] as const),
    ).values(),
  ];
  const children = items.reduce(
    (count, item) => count + item.children.length,
    0,
  );
  const summary = `Create ${String(items.length)} ${
    items.length === 1 ? "task" : "tasks"
  }${children === 0 ? "" : ` with ${String(children)} child ${children === 1 ? "task" : "tasks"}`}${
    affected.length === 0
      ? ""
      : `; creates ${String(affected.length)} ${affected.length === 1 ? "tag" : "tags"}`
  }: ${items.map((item) => quoted(item.title)).join(", ")}`;
  return { input: { ...command.input, items }, affected, summary };
};

export const confirmCaptureBatch = (
  database: SuiteDatabase,
  ownerId: string,
  key: string,
  hash: string,
  command: CaptureBatchCommand,
  now: string,
) => {
  const result = createCapturedTaskBatch(
    database,
    ownerId,
    key,
    hash,
    command.input,
    now,
    { allowNewTags: true },
  );
  if (result.kind === "conflict") return { kind: "conflict" as const };
  return {
    kind: result.kind,
    result: {
      tasks: result.tasks.map(taskResponse),
      replayed: result.kind === "replayed",
    },
  };
};
