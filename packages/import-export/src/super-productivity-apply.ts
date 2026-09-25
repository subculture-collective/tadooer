import { createHash } from "node:crypto";
import { organizationIconPattern } from "@suite/contracts";
import { previewSuperProductivity } from "./super-productivity.ts";
import {
  fieldsWith,
  populated,
  superProductivityNoteFields,
  superProductivityProjectFields,
  superProductivitySystemTagIds,
  superProductivityTagFields,
  superProductivityTaskFields,
  type FieldDisposition,
} from "./super-productivity-schema.ts";
import {
  mapAttachments,
  mapLinkedIssue,
  superProductivityLinkFields,
  type ImportedAttachment,
  type ImportedIssueLink,
} from "./super-productivity-links.ts";

type Source = Record<string, unknown>;
const object = (value: unknown): Source =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Source)
    : {};
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

export interface TaskImportRecord {
  sourceId: string;
  kind: "project" | "tag" | "task" | "note";
  sourceJson: string;
  sourceHash: string;
  title: string;
  /** Task notes, or the Markdown content of a note record. */
  notes: string;
  projectId: string | null;
  tagIds: string[];
  plannedStart: string | null;
  deadlineDate: string | null;
  deadlineAt: string | null;
  estimateMinutes: number | null;
  completedAt: string | null;
  createdAt: string | null;
  // Organization parity (#28). Records are emitted in display order.
  /** Super Productivity records no archive time; apply uses the import time. */
  archived?: boolean;
  color?: string | null;
  icon?: string | null;
  hiddenFromMenu?: boolean;
  backlogEnabled?: boolean;
  backlogTaskIds?: string[];
  pinnedToToday?: boolean;
  plannedDay: string | null;
  startReminder:
    | { kind: "default" }
    | { kind: "none" }
    | { kind: "before_start"; minutes: number };
  deadlineReminderMinutes: number | null;
  // Linked issue and attachments (ADR 0021); tasks only.
  issueLink?: ImportedIssueLink | null;
  attachments?: ImportedAttachment[];
}

/** Report codes that inform the owner without blocking apply. */
const nonBlockingCodes: ReadonlySet<string> = new Set([
  "configuration_not_imported",
  "issue_provider_missing",
]);

/** Normalizes #rgb/#rrggbb to lowercase #rrggbb; anything else is undefined. */
const hexColor = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  if (short !== null)
    return `#${short
      .slice(1)
      .map((digit) => digit.repeat(2))
      .join("")}`.toLowerCase();
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : undefined;
};

/** Depth-first menuTree order; folders are flattened, their names dropped. */
const menuOrder = (
  value: unknown,
  kind: "p" | "t",
): { order: string[]; folders: number; valid: boolean } => {
  const order: string[] = [];
  let folders = 0;
  let valid = value === undefined || Array.isArray(value);
  const visit = (nodes: unknown, depth: number) => {
    if (!Array.isArray(nodes) || depth > 32) {
      valid = false;
      return;
    }
    for (const raw of nodes) {
      const node = object(raw);
      if (node.k === "f") {
        folders++;
        visit(node.children ?? [], depth + 1);
      } else if (node.k === kind && typeof node.id === "string")
        order.push(node.id);
      else valid = false;
    }
  };
  if (Array.isArray(value)) visit(value, 0);
  return { order, folders, valid };
};

const byOrder = <T extends { sourceId: string }>(
  records: T[],
  order: readonly string[],
): T[] => {
  const rank = new Map(order.map((id, index) => [id, index]));
  return records
    .map((record, index) => ({ record, index }))
    .sort(
      (a, b) =>
        (rank.get(a.record.sourceId) ?? order.length + a.index) -
        (rank.get(b.record.sourceId) ?? order.length + b.index),
    )
    .map(({ record }) => record);
};

/** Super Productivity TaskReminderOptionId offsets: AtStart, m5, m10, m15, m30, h1. */
const reminderOffsets: readonly number[] = [0, 5, 10, 15, 30, 60];

const reminderAndDayFields = new Set([
  "dueDay",
  "remindAt",
  "deadlineRemindAt",
]);

/** Convert an absolute reminder to an offset only when it is exact; never round. */
const exactOffset = (occurrence: string, remindAt: unknown) => {
  if (typeof remindAt !== "number" || !Number.isSafeInteger(remindAt))
    return undefined;
  const difference = Date.parse(occurrence) - remindAt;
  if (difference < 0 || difference % 60000 !== 0) return undefined;
  const minutes = difference / 60000;
  return reminderOffsets.includes(minutes) ? minutes : undefined;
};

/** Reject unsupported workflows as a whole; never offer a silent partial import. */
export const prepareSuperProductivityImport = (raw: string) => {
  const inventory = previewSuperProductivity(raw);
  const issues = inventory.issues.filter(({ code }) => code !== "preview_only");
  const notice = (sourceId: string | null, detail: string) =>
    issues.push({ code: "configuration_not_imported", sourceId, detail });
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
  const preserve = (
    fields: Readonly<Record<string, FieldDisposition>>,
    source: Source,
    keep: (key: string) => boolean = () => true,
  ) => {
    // Persist reviewed fields only, never provider configuration credentials.
    const preserved = Object.fromEntries(
      fieldsWith(fields, "applied", "retained")
        .filter((key) => source[key] !== undefined && keep(key))
        .map((key) => [key, source[key]]),
    );
    const sourceJson = JSON.stringify(preserved);
    return {
      sourceJson,
      sourceHash: createHash("sha256").update(sourceJson).digest("hex"),
    };
  };
  const reviewFields = (
    kind: string,
    sourceId: string,
    source: Source,
    fields: Readonly<Record<string, FieldDisposition>>,
  ) => {
    for (const field of Object.keys(source))
      if (!Object.hasOwn(fields, field))
        problem(sourceId, `Unreviewed ${kind} field ${field} blocks import`);
    const blocked = fieldsWith(fields, "blocked").filter((field) =>
      populated(source[field]),
    );
    if (blocked.length > 0)
      problem(
        sourceId,
        `${blocked.join(", ")} need${blocked.length === 1 ? "s" : ""} parity support before import`,
      );
  };
  const issueProviders = object(object(data.issueProvider).entities);
  const noteState = object(data.note);
  const noteEntities = object(noteState.entities);
  const liveTasks = object(object(data.task).entities);
  const systemTags = new Set<string>(superProductivitySystemTagIds);
  const referencedTags = new Set(
    Object.values(liveTasks).flatMap((task) => strings(object(task).tagIds)),
  );
  for (const kind of ["project", "tag", "task"] as const) {
    const entities = object(object(data[kind]).entities);
    for (const [sourceId, value] of Object.entries(entities)) {
      const source = object(value);
      if (kind === "tag" && systemTags.has(sourceId)) {
        // Derived views and board markers are never ordinary imported tags.
        if (sourceId === "TODAY" && strings(source.taskIds).length > 0)
          problem(
            sourceId,
            "Today's task order needs date-only planning parity (#29); it is not an ordinary tag",
          );
        else if (referencedTags.has(sourceId))
          problem(
            sourceId,
            "Tasks use this Super Productivity system tag; priority and board markers need board parity (#63) and are not imported as ordinary tags",
          );
        else
          notice(
            sourceId,
            "Super Productivity system tag is a derived view and is not imported",
          );
        continue;
      }
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
      if (kind !== "task") reviewFields(kind, sourceId, source, fields);
      else {
        const blocked = fieldsWith(fields, "blocked").filter((field) =>
          populated(source[field]),
        );
        if (blocked.length > 0)
          problem(
            sourceId,
            `${blocked.join(", ")} need${blocked.length === 1 ? "s" : ""} parity support before import`,
          );
      }
      const task = kind === "task" ? taskById.get(sourceId) : undefined;
      // Source reminders are absolute; keep them only as exact offsets from
      // an exact start or deadline. A timed task without remindAt had no
      // reminder in the source, so it imports with reminders disabled.
      let startReminder: TaskImportRecord["startReminder"] = {
        kind: "default",
      };
      let deadlineReminderMinutes: number | null = null;
      if (task !== undefined) {
        if (task.scheduledAt !== null) {
          if (!populated(source.remindAt)) startReminder = { kind: "none" };
          else {
            const minutes = exactOffset(task.scheduledAt, source.remindAt);
            if (minutes === undefined)
              problem(
                sourceId,
                "remindAt is not exactly at start or 5, 10, 15, 30 or 60 minutes before dueWithTime; no rounding is applied",
              );
            else startReminder = { kind: "before_start", minutes };
          }
        } else if (populated(source.remindAt))
          problem(
            sourceId,
            "remindAt requires an exact dueWithTime; a date-only plan has no reminder time",
          );
        if (populated(source.deadlineRemindAt)) {
          const minutes =
            task.deadlineAt === null
              ? undefined
              : exactOffset(task.deadlineAt, source.deadlineRemindAt);
          if (minutes === undefined)
            problem(
              sourceId,
              "deadlineRemindAt must be exactly at or 5, 10, 15, 30 or 60 minutes before a timed deadline; no rounding is applied",
            );
          else deadlineReminderMinutes = minutes;
        }
      }
      if (
        [task?.scheduledAt, task?.deadlineAt].some(
          (value) => value != null && value.length !== 24,
        )
      )
        problem(
          sourceId,
          "Timestamp is outside the supported four-digit year range",
        );
      // Linked issue and attachments (ADR 0021). Diagnostics stay content-safe:
      // they never repeat issue IDs, addresses or provider configuration.
      const issueLink =
        kind === "task"
          ? mapLinkedIssue(
              source,
              issueProviders,
              (detail) => {
                problem(sourceId, detail);
              },
              (detail) =>
                issues.push({
                  code: "issue_provider_missing",
                  sourceId,
                  detail,
                }),
            )
          : null;
      const attachments =
        kind === "task"
          ? mapAttachments(source, (detail) => {
              problem(sourceId, detail);
            })
          : [];
      const estimate = task?.estimateMilliseconds ?? 0;
      if (estimate % 60000 !== 0 || estimate > 720 * 60000)
        problem(
          sourceId,
          "Estimate must fit whole minutes up to 720; no rounding is applied",
        );
      for (const flag of [
        "isDone",
        "isArchived",
        "isHiddenFromMenu",
        "isEnableBacklog",
      ])
        if (source[flag] !== undefined && typeof source[flag] !== "boolean")
          problem(sourceId, `${flag} must be Boolean`);
      const completedAt = source.isDone === true ? iso(source.doneOn) : null;
      if (source.isDone === true && completedAt === null)
        problem(
          sourceId,
          kind === "project"
            ? "Completed projects require their original completion timestamp"
            : "Completed tasks require their original completion timestamp",
        );
      const createdAt = iso(source.created);
      if (source.created !== undefined && createdAt === null)
        problem(sourceId, "Creation timestamp is invalid");
      if (Array.isArray(source.tagIds) && source.tagIds.length > 25)
        problem(sourceId, "Task has more than 25 tags");
      if (kind === "task")
        for (const tagId of strings(source.tagIds))
          if (systemTags.has(tagId) && tagId !== "TODAY")
            problem(
              sourceId,
              "Task uses a Super Productivity priority or board tag that is not imported as an ordinary tag",
            );
      const record: TaskImportRecord = {
        kind,
        sourceId,
        // Fields applied since #29 are kept only when they carry a value that
        // was applied, so provenance hashes of earlier imports stay stable. A
        // dueDay superseded by dueWithTime is not applied. Linked-issue and
        // attachment fields (#30) follow the same rule: empty defaults such as
        // attachments: [] stay out so earlier hashes do not change.
        ...preserve(
          fields,
          source,
          (key) =>
            kind !== "task" ||
            (superProductivityLinkFields.has(key)
              ? populated(source[key])
              : !reminderAndDayFields.has(key) ||
                (populated(source[key]) &&
                  (key !== "dueDay" || task?.scheduledDay != null))),
        ),
        title,
        notes,
        projectId: task?.projectId ?? null,
        // TODAY in tagIds is legacy view membership, not a tag assignment.
        tagIds: strings(source.tagIds).filter((id) => id !== "TODAY"),
        plannedStart: task?.scheduledAt ?? null,
        plannedDay: task?.scheduledDay ?? null,
        startReminder,
        deadlineReminderMinutes,
        deadlineDate: task?.deadlineDay ?? null,
        deadlineAt: task?.deadlineAt ?? null,
        estimateMinutes: estimate === 0 ? null : estimate / 60000,
        completedAt,
        createdAt,
      };
      if (kind === "task" && (issueLink !== null || attachments.length > 0)) {
        record.issueLink = issueLink;
        record.attachments = attachments;
      }
      if (kind !== "task") {
        const icon = source.icon;
        if (
          icon !== undefined &&
          icon !== null &&
          icon !== "" &&
          (typeof icon !== "string" || !organizationIconPattern.test(icon))
        )
          problem(
            sourceId,
            "Icon must be a lowercase icon name or a single emoji",
          );
        const color = hexColor(source.color);
        if (populated(source.color) && color === undefined)
          problem(sourceId, "Colour must be a hex colour such as #3366cc");
        record.icon =
          typeof icon === "string" && organizationIconPattern.test(icon)
            ? icon
            : null;
        record.color = color ?? hexColor(object(source.theme).primary) ?? null;
        record.archived = source.isArchived === true;
      }
      if (kind === "project") {
        record.hiddenFromMenu = source.isHiddenFromMenu === true;
        record.backlogEnabled = source.isEnableBacklog === true;
        const backlog = strings(source.backlogTaskIds);
        if (
          source.backlogTaskIds !== undefined &&
          (!Array.isArray(source.backlogTaskIds) ||
            backlog.length !== source.backlogTaskIds.length)
        )
          problem(sourceId, "backlogTaskIds must contain task IDs");
        if (backlog.length > 0 && source.isEnableBacklog !== true)
          problem(
            sourceId,
            "Backlog tasks exist while the project backlog is disabled",
          );
        record.backlogTaskIds = backlog.filter((taskId) => {
          const backlogTask = taskById.get(taskId);
          if (backlogTask === undefined) {
            notice(
              sourceId,
              "A backlog entry references a task absent from the export and is not imported",
            );
            return false;
          }
          if (backlogTask.archived || backlogTask.projectId !== sourceId)
            problem(
              sourceId,
              "A backlog entry references a task outside this project's active tasks",
            );
          return true;
        });
      }
      records.push(record);
    }
  }
  const menuTree = object(data.menuTree);
  const projectMenu = menuOrder(menuTree.projectTree, "p");
  const tagMenu = menuOrder(menuTree.tagTree, "t");
  if (!projectMenu.valid || !tagMenu.valid)
    problem("menuTree", "menuTree nodes must be folders, projects or tags");
  if (projectMenu.folders + tagMenu.folders > 0)
    notice(
      "menuTree",
      "menuTree folders are not imported; project and tag order is applied without folders",
    );

  const noteRecords: TaskImportRecord[] = [];
  const projectEntities = object(object(data.project).entities);
  for (const [sourceId, value] of Object.entries(noteEntities)) {
    const source = object(value);
    reviewFields("note", sourceId, source, superProductivityNoteFields);
    const content = source.content;
    if (
      source.id !== sourceId ||
      typeof content !== "string" ||
      content.length > 20000
    )
      problem(sourceId, "Note content or identity cannot be represented");
    const projectId =
      typeof source.projectId === "string" ? source.projectId : null;
    if (source.projectId != null && typeof source.projectId !== "string")
      problem(sourceId, "Note projectId must be a project ID");
    if (projectId !== null && !Object.hasOwn(projectEntities, projectId))
      problem(sourceId, "Note references a project absent from the export");
    if (
      source.isPinnedToToday !== undefined &&
      typeof source.isPinnedToToday !== "boolean"
    )
      problem(sourceId, "isPinnedToToday must be Boolean");
    const createdAt = iso(source.created);
    if (source.created !== undefined && createdAt === null)
      problem(sourceId, "Creation timestamp is invalid");
    noteRecords.push({
      kind: "note",
      sourceId,
      ...preserve(superProductivityNoteFields, source),
      title: "",
      notes: typeof content === "string" ? content : "",
      projectId,
      tagIds: [],
      plannedStart: null,
      plannedDay: null,
      startReminder: { kind: "default" },
      deadlineReminderMinutes: null,
      deadlineDate: null,
      deadlineAt: null,
      estimateMinutes: null,
      completedAt: null,
      createdAt,
      pinnedToToday: source.isPinnedToToday === true,
    });
  }
  if (strings(noteState.todayOrder).length > 0)
    notice(
      "note",
      "Today's pinned-note order is not imported; pinned notes keep their project order",
    );
  const projects = byOrder(
    records.filter(({ kind }) => kind === "project"),
    projectMenu.order,
  );
  // Project noteIds order each project's notes; other notes keep export order.
  const noteOrder: string[] = [];
  for (const project of projects)
    for (const noteId of strings(
      object(projectEntities[project.sourceId]).noteIds,
    )) {
      const note = object(noteEntities[noteId]);
      if (Object.keys(note).length === 0)
        notice(
          project.sourceId,
          "A project noteIds entry references a note absent from the export",
        );
      else if (note.projectId !== project.sourceId)
        problem(noteId, "Project noteIds lists a note of another project");
      else if (!noteOrder.includes(noteId)) noteOrder.push(noteId);
    }
  noteOrder.push(
    ...strings(noteState.ids).filter((id) => !noteOrder.includes(id)),
  );
  const ordered = [
    ...projects,
    ...byOrder(
      records.filter(({ kind }) => kind === "tag"),
      tagMenu.order,
    ),
    ...records.filter(({ kind }) => kind === "task"),
    ...byOrder(noteRecords, noteOrder),
  ];
  if (inventory.totals.archived > 0)
    problem(
      "archive",
      "Archived task history is not supported by this initial apply path",
    );
  if (ordered.length === 0) problem("export", "No supported records to import");
  const notices = issues.filter(({ code }) => nonBlockingCodes.has(code));
  return {
    report: {
      ...inventory,
      canApply: issues.length === notices.length,
      issues,
    },
    records: ordered,
  };
};
