import { createHash } from "node:crypto";
import { previewSuperProductivity } from "./super-productivity.ts";

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
}

/** Reject unsupported workflows as a whole; never offer a silent partial import. */
export const prepareSuperProductivityImport = (raw: string) => {
  const inventory = previewSuperProductivity(raw);
  const issues = inventory.issues.filter(({ code }) => code !== "preview_only");
  const root = object(JSON.parse(raw) as unknown);
  const data = root.data === undefined ? root : object(root.data);
  const records: TaskImportRecord[] = [];
  const taskById = new Map(
    inventory.tasks.map((task) => [task.sourceId, task]),
  );
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
      if (kind !== "task" && notes !== "")
        problem(
          sourceId,
          "Project/tag notes need their own parity support before import",
        );
      for (const field of [
        "attachments",
        "noteIds",
        "issueId",
        "remindAt",
        "backlogTaskIds",
      ])
        if (
          source[field] !== undefined &&
          source[field] !== null &&
          source[field] !== "" &&
          (!Array.isArray(source[field]) || source[field].length > 0)
        )
          problem(sourceId, `${field} needs parity support before import`);
      if (kind === "tag" && sourceId === "TODAY")
        problem(
          sourceId,
          "The Today virtual view must not be imported as an ordinary tag",
        );
      if (kind !== "task" && source.isDone === true)
        problem(
          sourceId,
          "Completed projects need project lifecycle support before import",
        );
      if (source.isArchived === true)
        problem(
          sourceId,
          "Archived projects/tags need history support before import",
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
      const estimate = task?.estimateMilliseconds ?? 0;
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
      // Persist only task metadata, never project/provider configuration credentials.
      const preserved = Object.fromEntries(
        [
          "id",
          "title",
          "notes",
          "projectId",
          "tagIds",
          "created",
          "doneOn",
          "isDone",
          "dueWithTime",
          "deadlineDay",
          "deadlineWithTime",
          "timeEstimate",
        ]
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
    report: { ...inventory, canApply: issues.length === 0, issues },
    records,
  };
};
