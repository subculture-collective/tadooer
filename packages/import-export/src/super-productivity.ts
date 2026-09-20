import { createHash } from "node:crypto";

type ObjectValue = Readonly<Record<string, unknown>>;
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;

export interface SuperProductivityPreview {
  readonly source: "super_productivity";
  readonly inputHash: string;
  readonly canApply: false;
  readonly totals: {
    readonly tasks: number;
    readonly completed: number;
    readonly archived: number;
    readonly childTasks: number;
    readonly projects: number;
    readonly tags: number;
    readonly repeatConfigurations: number;
    readonly trackedMilliseconds: number;
  };
  readonly tasks: readonly {
    readonly sourceId: string;
    readonly title: string;
    readonly completed: boolean;
    readonly archived: boolean;
    readonly parentId: string | null;
    readonly projectId: string | null;
    readonly repeatConfigId: string | null;
    readonly estimateMilliseconds: number;
    readonly trackedMilliseconds: number;
    readonly scheduledAt: string | null;
    readonly scheduledDay: string | null;
    readonly deadlineAt: string | null;
    readonly deadlineDay: string | null;
  }[];
  readonly issues: readonly {
    readonly code: string;
    readonly sourceId: string | null;
    readonly detail: string;
  }[];
}

/** Read-only inventory: never claims unsupported data has been migrated. */
export const previewSuperProductivity = (
  raw: string,
): SuperProductivityPreview => {
  if (Buffer.byteLength(raw, "utf8") > 4 * 1024 * 1024)
    throw new Error("Export exceeds the initial 4 MiB preview limit");
  const parsed: unknown = JSON.parse(raw);
  const envelope = object(parsed);
  const data = object(envelope?.data) ?? envelope;
  if (data === undefined || object(data.task) === undefined)
    throw new Error(
      "Expected a Super Productivity export containing task entities",
    );
  const issues: { code: string; sourceId: string | null; detail: string }[] =
    [];
  const issue = (code: string, sourceId: string | null, detail: string) => {
    issues.push({ code, sourceId, detail });
  };
  const entities = (value: unknown, label: string): ObjectValue => {
    if (value === undefined) return {};
    const state = object(value);
    const records = object(state?.entities);
    if (records === undefined || !Array.isArray(state?.ids)) {
      issue(
        "invalid_entity_store",
        null,
        `${label} must contain ids and entities`,
      );
      return {};
    }
    const ids = state.ids as unknown[];
    const seen = new Set<string>();
    for (const id of ids) {
      if (typeof id !== "string" || !Object.hasOwn(records, id))
        issue(
          "missing_entity",
          typeof id === "string" ? id : null,
          `${label} index references a missing entity`,
        );
      else if (seen.has(id))
        issue("duplicate_index", id, `${label} repeats an entity ID`);
      else seen.add(id);
    }
    for (const id of Object.keys(records))
      if (!seen.has(id))
        issue(
          "unindexed_entity",
          id,
          `${label} contains an entity outside its index`,
        );
    return records;
  };
  const projects = entities(data.project, "project");
  const tags = entities(data.tag, "tag");
  const repeats = entities(data.taskRepeatCfg, "taskRepeatCfg");
  const archiveTasks = (name: "archiveYoung" | "archiveOld") => {
    if (data[name] === undefined) return {};
    const archive = object(data[name]);
    if (archive?.task === undefined) {
      issue(
        "invalid_archive",
        null,
        `${name} must contain a task entity store; archived history cannot be inventoried`,
      );
      return {};
    }
    return entities(archive.task, `${name}.task`);
  };
  const sources = [
    { records: entities(data.task, "task"), archived: false },
    {
      records: archiveTasks("archiveYoung"),
      archived: true,
    },
    {
      records: archiveTasks("archiveOld"),
      archived: true,
    },
  ];
  const tasks: SuperProductivityPreview["tasks"][number][] = [];
  const seen = new Set<string>();
  const children = new Map<string, Set<string>>();
  const number = (value: unknown, id: string, name: string): number => {
    if (value === undefined || value === null) return 0;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      issue(
        "invalid_duration",
        id,
        `${name} must be a nonnegative integer in milliseconds`,
      );
      return 0;
    }
    return value;
  };
  const timestamp = (
    value: unknown,
    id: string,
    name: string,
  ): string | null => {
    if (value === undefined || value === null) return null;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      !Number.isFinite(new Date(value).getTime())
    ) {
      issue(
        "invalid_timestamp",
        id,
        `${name} must be a valid epoch-millisecond timestamp`,
      );
      return null;
    }
    return new Date(value).toISOString();
  };
  const day = (value: unknown, id: string, name: string): string | null => {
    if (value === undefined || value === null) return null;
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value
    ) {
      issue("invalid_date", id, `${name} must be a calendar date`);
      return null;
    }
    return value;
  };
  for (const source of sources)
    for (const [id, value] of Object.entries(source.records)) {
      if (seen.has(id)) {
        issue(
          "duplicate_task",
          id,
          "Task appears in more than one live/archive store; resolve before importing",
        );
        continue;
      }
      seen.add(id);
      const task = object(value);
      if (
        task?.id !== id ||
        typeof task.title !== "string" ||
        task.title.trim() === ""
      ) {
        issue(
          "invalid_task",
          id,
          "Task requires a matching ID and nonempty title",
        );
        continue;
      }
      const projectId =
        typeof task.projectId === "string" ? task.projectId : null;
      const parentId = typeof task.parentId === "string" ? task.parentId : null;
      const repeatConfigId =
        typeof task.repeatCfgId === "string" ? task.repeatCfgId : null;
      if (projectId !== null && !Object.hasOwn(projects, projectId))
        issue(
          "missing_project",
          id,
          "Referenced project is absent from the export",
        );
      if (repeatConfigId !== null && !Object.hasOwn(repeats, repeatConfigId))
        issue(
          "missing_repeat_config",
          id,
          "Referenced repeat configuration is absent",
        );
      for (const field of ["parentId", "projectId", "repeatCfgId"] as const)
        if (
          task[field] !== undefined &&
          task[field] !== null &&
          (typeof task[field] !== "string" || task[field] === "")
        )
          issue(
            "invalid_reference",
            id,
            `${field} must be a nonempty source ID`,
          );
      for (const field of ["tagIds", "subTaskIds"] as const) {
        if (task[field] === undefined) continue;
        const refs = task[field];
        if (
          !Array.isArray(refs) ||
          refs.some((ref) => typeof ref !== "string" || ref === "")
        ) {
          issue(
            "invalid_reference_list",
            id,
            `${field} must contain source IDs`,
          );
          continue;
        }
        const unique = new Set<string>(refs as string[]);
        if (unique.size !== refs.length)
          issue("duplicate_reference", id, `${field} repeats an ID`);
        if (field === "subTaskIds") children.set(id, unique);
        else
          for (const tagId of unique)
            if (!Object.hasOwn(tags, tagId))
              issue(
                "missing_tag",
                id,
                "Referenced tag is absent from the export",
              );
      }
      const trackedMilliseconds = number(task.timeSpent, id, "timeSpent");
      const daily = object(task.timeSpentOnDay);
      if (task.timeSpentOnDay !== undefined && daily === undefined)
        issue(
          "invalid_time_history",
          id,
          "timeSpentOnDay must map calendar dates to milliseconds",
        );
      if (daily !== undefined) {
        let total = 0;
        for (const [date, entry] of Object.entries(daily)) {
          day(date, id, "timeSpentOnDay date");
          total += number(entry, id, "timeSpentOnDay");
        }
        if (!Number.isSafeInteger(total))
          issue(
            "time_total_overflow",
            id,
            "Daily tracked time exceeds safe integer precision",
          );
        if (total !== trackedMilliseconds)
          issue(
            "time_total_mismatch",
            id,
            "Daily tracked time does not equal the task total; do not sum parent and child totals blindly",
          );
      }
      const scheduledAt = timestamp(task.dueWithTime, id, "dueWithTime");
      const deadlineAt = timestamp(
        task.deadlineWithTime,
        id,
        "deadlineWithTime",
      );
      tasks.push({
        sourceId: id,
        title: task.title,
        completed: task.isDone === true,
        archived: source.archived,
        parentId,
        projectId,
        repeatConfigId,
        trackedMilliseconds,
        estimateMilliseconds: number(task.timeEstimate, id, "timeEstimate"),
        scheduledAt,
        scheduledDay:
          scheduledAt === null ? day(task.dueDay, id, "dueDay") : null,
        deadlineAt,
        deadlineDay:
          deadlineAt === null ? day(task.deadlineDay, id, "deadlineDay") : null,
      });
    }
  const taskIds = new Set(tasks.map((task) => task.sourceId));
  const parentIds = new Set(tasks.map((task) => task.parentId));
  for (const task of tasks)
    if (task.parentId !== null && !taskIds.has(task.parentId))
      issue(
        "missing_parent",
        task.sourceId,
        "Parent task is absent from all task stores",
      );
  const byId = new Map(tasks.map((task) => [task.sourceId, task]));
  for (const [parentId, refs] of children)
    for (const childId of refs) {
      const child = byId.get(childId);
      if (child === undefined)
        issue(
          "missing_child",
          parentId,
          "Listed child is absent from all task stores",
        );
      else if (child.parentId !== parentId)
        issue(
          "hierarchy_mismatch",
          childId,
          "Child parentId disagrees with the parent's subTaskIds",
        );
    }
  for (const task of tasks)
    if (
      task.parentId !== null &&
      children.has(task.parentId) &&
      !children.get(task.parentId)?.has(task.sourceId)
    )
      issue(
        "hierarchy_mismatch",
        task.sourceId,
        "Parent subTaskIds omits this child",
      );
  // Iterative, linear graph walk: deep exports must not overflow the call stack.
  const checked = new Set<string>();
  for (const task of tasks) {
    const path = new Set<string>();
    let current: string | null = task.sourceId;
    while (current !== null && byId.has(current) && !checked.has(current)) {
      if (path.has(current)) {
        issue(
          "hierarchy_cycle",
          current,
          "Parent relationships contain a cycle; resolve it before importing",
        );
        break;
      }
      path.add(current);
      current = byId.get(current)?.parentId ?? null;
    }
    for (const id of path) checked.add(id);
  }
  if (tasks.some((task) => task.parentId !== null))
    issue(
      "hierarchy_parity_required",
      null,
      "Source subtasks are full tasks; do not flatten them into checklist items",
    );
  if (Object.keys(repeats).length > 0)
    issue(
      "recurrence_parity_required",
      null,
      "Task recurrence must be implemented before repeat configurations can be applied",
    );
  if (tasks.some((task) => task.trackedMilliseconds > 0))
    issue(
      "time_history_parity_required",
      null,
      "Preserve daily time entries and archives before applying tracked history",
    );
  issue(
    "preview_only",
    null,
    "Inventory only: no data was written. Keep the original export for the later transactional import.",
  );
  return {
    source: "super_productivity",
    inputHash: createHash("sha256")
      .update(JSON.stringify(parsed))
      .digest("hex"),
    canApply: false,
    totals: {
      tasks: tasks.length,
      completed: tasks.filter((task) => task.completed).length,
      archived: tasks.filter((task) => task.archived).length,
      childTasks: tasks.filter((task) => task.parentId !== null).length,
      projects: Object.keys(projects).length,
      tags: Object.keys(tags).length,
      repeatConfigurations: Object.keys(repeats).length,
      // Child time is already included in some source parent totals.
      trackedMilliseconds: tasks
        .filter((task) => !parentIds.has(task.sourceId))
        .reduce((sum, task) => sum + task.trackedMilliseconds, 0),
    },
    tasks,
    issues,
  };
};
