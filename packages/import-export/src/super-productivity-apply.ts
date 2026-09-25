import { createHash } from "node:crypto";
import { previewSuperProductivity } from "./super-productivity.ts";
import {
  fieldsWith,
  populated,
  superProductivityProjectFields,
  superProductivityTagFields,
  superProductivityTaskFields,
} from "./super-productivity-schema.ts";

type Source = Record<string, unknown>;
const object = (value: unknown): Source =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Source)
    : {};
export interface TaskImportRecord {
  sourceId: string;
  kind: "project" | "tag" | "task";
  sourceJson: string;
  sourceHash: string;
  title: string;
  notes: string;
  projectId: string | null;
  tagIds: string[];
  plannedStart: string | null;
  deadlineDate: string | null;
  deadlineAt: string | null;
  estimateMinutes: number | null;
  completedAt: string | null;
  createdAt: string | null;
  /** Source parent task ID; imported as a full child task (ADR 0018). */
  parentSourceId: string | null;
  /** Position in the source parent's subTaskIds. */
  childIndex: number | null;
}

/** Reject unsupported workflows as a whole; never offer a silent partial import. */
export const prepareSuperProductivityImport = (raw: string) => {
  const inventory = previewSuperProductivity(raw);
  const issues = inventory.issues.filter(({ code }) => code !== "preview_only");
  // Reported to the owner without blocking; see super-productivity-schema.ts.
  const notices = issues.filter(
    ({ code }) => code === "configuration_not_imported",
  );
  const root = object(JSON.parse(raw) as unknown);
  const data = root.data === undefined ? root : object(root.data);
  const records: TaskImportRecord[] = [];
  const taskById = new Map(
    inventory.tasks.map((task) => [task.sourceId, task]),
  );
  // Source parent estimates are derived from their children, so the
  // importer keeps them only in provenance rather than double counting.
  const parentsWithChildren = new Set(
    inventory.tasks.flatMap(({ parentId }) =>
      parentId === null ? [] : [parentId],
    ),
  );
  const taskEntities = object(object(data.task).entities);
  const childIndex = (parentId: string | null, sourceId: string) => {
    if (parentId === null) return null;
    const siblings = object(taskEntities[parentId]).subTaskIds;
    const index = Array.isArray(siblings) ? siblings.indexOf(sourceId) : -1;
    return index === -1 ? null : index;
  };
  const problem = (sourceId: string, detail: string) =>
    issues.push({ code: "unsupported_import_data", sourceId, detail });
  const iso = (value: unknown): string | null =>
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    Number.isFinite(new Date(value).getTime()) &&
    new Date(value).toISOString().length === 24
      ? new Date(value).toISOString()
      : null;
  for (const kind of ["project", "tag", "task"] as const) {
    const entities = object(object(data[kind]).entities);
    for (const [sourceId, value] of Object.entries(entities)) {
      const source = object(value);
      const title = typeof source.title === "string" ? source.title.trim() : "";
      if (
        source.id !== sourceId ||
        !title ||
        title.length > (kind === "tag" ? 100 : 240)
      )
        problem(
          sourceId,
          "Title or entity identity cannot be represented without changes",
        );
      const notes = typeof source.notes === "string" ? source.notes : "";
      if (
        (source.notes !== undefined && typeof source.notes !== "string") ||
        notes.length > 20000
      )
        problem(sourceId, "Notes cannot be represented without changes");
      const fields = {
        project: superProductivityProjectFields,
        tag: superProductivityTagFields,
        task: superProductivityTaskFields,
      }[kind];
      for (const field of Object.keys(source))
        if (kind !== "task" && !Object.hasOwn(fields, field))
          problem(sourceId, `Unreviewed ${kind} field ${field} blocks import`);
      const blocked = fieldsWith(fields, "blocked").filter((field) =>
        populated(source[field]),
      );
      if (blocked.length > 0)
        problem(
          sourceId,
          `${blocked.join(", ")} need${blocked.length === 1 ? "s" : ""} parity support before import`,
        );
      if (kind === "tag" && sourceId === "TODAY")
        problem(
          sourceId,
          "The Today virtual view must not be imported as an ordinary tag",
        );
      const task = kind === "task" ? taskById.get(sourceId) : undefined;
      if (task?.scheduledDay !== null && task?.scheduledDay !== undefined)
        problem(
          sourceId,
          "Day-only scheduling cannot be converted to an arbitrary time",
        );
      if (
        [task?.scheduledAt, task?.deadlineAt].some(
          (value) => value != null && value.length !== 24,
        )
      )
        problem(
          sourceId,
          "Timestamp is outside the supported four-digit year range",
        );
      const derivedEstimate = parentsWithChildren.has(sourceId);
      const estimate = derivedEstimate ? 0 : (task?.estimateMilliseconds ?? 0);
      if (estimate % 60000 !== 0 || estimate > 720 * 60000)
        problem(
          sourceId,
          "Estimate must fit whole minutes up to 720; no rounding is applied",
        );
      if (source.isDone !== undefined && typeof source.isDone !== "boolean")
        problem(sourceId, "Completion status must be Boolean");
      const completedAt = source.isDone === true ? iso(source.doneOn) : null;
      if (source.isDone === true && completedAt === null)
        problem(
          sourceId,
          "Completed tasks require their original completion timestamp",
        );
      const createdAt = iso(source.created);
      if (source.created !== undefined && createdAt === null)
        problem(sourceId, "Creation timestamp is invalid");
      if (Array.isArray(source.tagIds) && source.tagIds.length > 25)
        problem(sourceId, "Task has more than 25 tags");
      // Persist reviewed fields only, never provider configuration credentials.
      const preserved = Object.fromEntries(
        fieldsWith(fields, "applied", "retained")
          .filter((key) => source[key] !== undefined)
          .map((key) => [key, source[key]]),
      );
      const sourceJson = JSON.stringify(preserved);
      records.push({
        kind,
        sourceId,
        sourceJson,
        sourceHash: createHash("sha256").update(sourceJson).digest("hex"),
        title,
        notes,
        projectId: task?.projectId ?? null,
        tagIds: Array.isArray(source.tagIds)
          ? source.tagIds.filter((id): id is string => typeof id === "string")
          : [],
        plannedStart: task?.scheduledAt ?? null,
        deadlineDate: task?.deadlineDay ?? null,
        deadlineAt: task?.deadlineAt ?? null,
        estimateMinutes: estimate === 0 ? null : estimate / 60000,
        completedAt,
        createdAt,
        parentSourceId: task?.parentId ?? null,
        childIndex: childIndex(task?.parentId ?? null, sourceId),
      });
    }
  }
  if (inventory.totals.archived > 0)
    problem(
      "archive",
      "Archived task history is not supported by this initial apply path",
    );
  if (records.length === 0) problem("export", "No supported records to import");
  return {
    report: {
      ...inventory,
      canApply: issues.length === notices.length,
      issues,
    },
    records,
  };
};
