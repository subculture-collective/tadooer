import { superProductivityImportLimits as limits } from "@suite/contracts/import-limits";
import { createHash } from "node:crypto";
import {
  untitledArchivedTaskTitle,
  type HistoricalReference,
  type TaskArchiveReviewReason,
} from "@suite/contracts";
import {
  fieldsWith,
  populated,
  superProductivityArchiveKeys,
  superProductivitySections,
  superProductivitySystemTagIds,
  superProductivityTaskFields,
} from "./super-productivity-schema.ts";
import {
  mapRepeatConfigs,
  occurrenceDateOf,
  type SuperProductivityOccurrenceLink,
  type SuperProductivitySeriesRecord,
} from "./super-productivity-recurrence.ts";
import {
  dayLimitMs,
  readWorkContexts,
  reconcileTaskTime,
  reconciliationSummary,
  type SourceTaskTime,
  type SourceTimeEntry,
  type SourceWorkContextDay,
  type TimeReconciliation,
} from "./super-productivity-time.ts";
import {
  counterReconciliation,
  counterReconciliationSummary,
  readMetrics,
  readSimpleCounters,
  type CounterReconciliation,
  type SourceCounter,
  type SourceEvaluation,
} from "./super-productivity-counters.ts";
import {
  mapPluginSections,
  type SuperProductivityPlugins,
} from "./super-productivity-plugins.ts";

const systemTagIds = new Set<string>(superProductivitySystemTagIds);

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
    /** Work history reconciliation (ADR 0024). */
    readonly time: TimeReconciliation;
    /** Counters and daily evaluations (ADR 0025). */
    readonly counters: CounterReconciliation;
  };
  readonly tasks: readonly {
    readonly sourceId: string;
    readonly title: string;
    readonly completed: boolean;
    readonly archived: boolean;
    /** Source store holding the imported copy (ADR 0022). */
    readonly store: SuperProductivityTaskStore;
    /** Why the owner should review this historical record; empty when none. */
    readonly review: readonly TaskArchiveReviewReason[];
    /** Source references kept as read-only provenance, not live links. */
    readonly historicalReferences: readonly HistoricalReference[];
    readonly parentId: string | null;
    readonly projectId: string | null;
    readonly repeatConfigId: string | null;
    readonly estimateMilliseconds: number;
    readonly trackedMilliseconds: number;
    readonly scheduledAt: string | null;
    readonly scheduledDay: string | null;
    readonly deadlineAt: string | null;
    readonly deadlineDay: string | null;
    /** ADR 0023: occurrence date when the task links to a repeat configuration. */
    readonly occurrenceDate: string | null;
  }[];
  readonly issues: readonly {
    readonly code: string;
    readonly sourceId: string | null;
    readonly detail: string;
  }[];
}

export type SuperProductivityTaskStore = "task" | "archiveYoung" | "archiveOld";

/** Deterministic JSON with sorted object keys, for comparing source copies. */
const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, nested: unknown) =>
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested as Record<string, unknown>).toSorted(
            ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
          ),
        )
      : nested,
  );

/** Fields whose values differ between two copies of one task, ignoring view state. */
const divergentFields = (left: ObjectValue, right: ObjectValue): string[] => {
  const ignored = new Set(fieldsWith(superProductivityTaskFields, "ignored"));
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter(
      (field) =>
        !ignored.has(field) &&
        stableJson(left[field]) !== stableJson(right[field]),
    )
    .toSorted();
};

export interface SuperProductivityImportOptions {
  /** Owner planning zone; reads source creation times as calendar dates. */
  readonly timeZone?: string;
  /**
   * ADR 0027: the owner's current planning date, which receives
   * TODAY_TAG.taskIds. Defaults to the current date in `timeZone`.
   */
  readonly today?: string;
}

/** Repeat configurations mapped to series, and the instances linked to them. */
export interface SuperProductivityRecurrence {
  readonly series: readonly SuperProductivitySeriesRecord[];
  readonly links: readonly SuperProductivityOccurrenceLink[];
}

/** Read-only inventory: never claims unsupported data has been migrated. */
export const previewSuperProductivity = (
  raw: string,
  options: SuperProductivityImportOptions = {},
): SuperProductivityPreview => inventorySuperProductivity(raw, options).preview;

/**
 * The preview together with recurring series and their instance links
 * (ADR 0023), and the reconciled daily time entries per source task and the
 * merged work start/end records (ADR 0024).
 */
export const inventorySuperProductivity = (
  raw: string,
  options: SuperProductivityImportOptions = {},
): {
  readonly preview: SuperProductivityPreview;
  readonly recurrence: SuperProductivityRecurrence;
  readonly timeEntries: ReadonlyMap<string, readonly SourceTimeEntry[]>;
  readonly workContexts: readonly SourceWorkContextDay[];
  readonly counters: readonly SourceCounter[];
  readonly evaluations: readonly SourceEvaluation[];
  /** Opaque plugin data and inert plugin metadata (ADR 0026). */
  readonly plugins: SuperProductivityPlugins;
} => {
  const timeZone = options.timeZone ?? "UTC";
  if (Buffer.byteLength(raw, "utf8") > limits.bytes)
    throw new Error(`Export exceeds the ${limits.label} import limit`);
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
    if (issues.length >= limits.issues)
      throw new Error("Export exceeds the import diagnostic budget");
    issues.push({ code, sourceId, detail });
  };
  let recordCount = 0;
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
    recordCount += Math.max(Object.keys(records).length, state.ids.length);
    if (recordCount > limits.records)
      throw new Error("Export exceeds the 50,000 record import limit");
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
  for (const [name, value] of Object.entries(data)) {
    if (!Object.hasOwn(superProductivitySections, name)) {
      issue(
        "unknown_section",
        null,
        `${name} is not a reviewed Super Productivity 19.1.0 export section`,
      );
      continue;
    }
    const disposition =
      superProductivitySections[name as keyof typeof superProductivitySections];
    if (disposition === "applied") continue;
    const store = object(value);
    const blocking =
      disposition === "blocked" &&
      (Array.isArray(store?.ids) ? store.ids.length > 0 : populated(value));
    if (blocking)
      issue(
        "unsupported_section",
        null,
        `${name} contains data without Tadooer parity; keep the original export`,
      );
    else if (
      disposition === "configuration" &&
      (Array.isArray(store?.ids) ? store.ids.length > 0 : populated(value))
    )
      issue(
        "configuration_not_imported",
        null,
        `${name} is configuration and is not applied; keep the original export`,
      );
  }
  // ADR 0026: plugin data is kept opaque; malformed entries block.
  const plugins = mapPluginSections(data, issue);
  const unknownFields = new Map<string, number>();
  const projects = entities(data.project, "project");
  const tags = entities(data.tag, "tag");
  const repeats = entities(data.taskRepeatCfg, "taskRepeatCfg");
  // ADR 0023: repeat configurations map to recurring series. Unmappable
  // options block with a specific finding per configuration.
  const series = mapRepeatConfigs(repeats, {
    projects,
    tags,
    timeZone,
    problem: (sourceId, detail) => {
      issue("recurrence_unmappable", sourceId, detail);
    },
    notice: (sourceId, detail) => {
      issue("recurrence_notice", sourceId, detail);
    },
  });
  const links: SuperProductivityOccurrenceLink[] = [];
  const occurrenceKeys = new Set<string>();
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
    for (const key of Object.keys(archive))
      if (!Object.hasOwn(superProductivityArchiveKeys, key))
        issue(
          "unknown_section",
          null,
          `${name}.${key} is not a reviewed Super Productivity 19.1.0 archive field`,
        );
    return entities(archive.task, `${name}.task`);
  };
  const sources: {
    readonly records: ObjectValue;
    readonly archived: boolean;
    readonly store: SuperProductivityTaskStore;
  }[] = [
    { records: entities(data.task, "task"), archived: false, store: "task" },
    {
      records: archiveTasks("archiveYoung"),
      archived: true,
      store: "archiveYoung",
    },
    {
      records: archiveTasks("archiveOld"),
      archived: true,
      store: "archiveOld",
    },
  ];
  type InventoryTask = SuperProductivityPreview["tasks"][number] & {
    review: TaskArchiveReviewReason[];
    historicalReferences: HistoricalReference[];
  };
  const tasks: InventoryTask[] = [];
  const taskTimes: SourceTaskTime[] = [];
  // First copy by store order (live, archiveYoung, archiveOld).
  const seen = new Map<
    string,
    { store: SuperProductivityTaskStore; value: unknown }
  >();
  const historicalCounts = new Map<string, number>();
  const countHistorical = (key: string) =>
    historicalCounts.set(key, (historicalCounts.get(key) ?? 0) + 1);
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
      // ADR 0022: identical copies collapse to the first store's copy and are
      // reported; divergent copies block. The importer never picks silently.
      const earlier = seen.get(id);
      if (earlier !== undefined) {
        const differences = divergentFields(
          object(earlier.value) ?? {},
          object(value) ?? {},
        );
        if (differences.length === 0)
          issue(
            "duplicate_copy_collapsed",
            id,
            `Identical copies in ${earlier.store} and ${source.store}; the ${earlier.store} copy is imported once`,
          );
        else
          issue(
            "duplicate_task",
            id,
            `Task appears in ${earlier.store} and ${source.store} with different ${differences.join(", ")}; resolve it in Super Productivity before importing`,
          );
        continue;
      }
      seen.set(id, { store: source.store, value });
      const task = object(value);
      const blankArchivedTitle =
        source.archived &&
        task?.id === id &&
        typeof task.title === "string" &&
        task.title.trim() === "";
      if (
        task?.id !== id ||
        typeof task.title !== "string" ||
        (task.title.trim() === "" && !blankArchivedTitle)
      ) {
        issue(
          "invalid_task",
          id,
          "Task requires a matching ID and nonempty title",
        );
        continue;
      }
      const review: TaskArchiveReviewReason[] = [];
      const historicalReferences: HistoricalReference[] = [];
      if (blankArchivedTitle) {
        review.push("blank_title");
        issue(
          "history_review",
          id,
          `Archived task has a blank title; it is imported as "${untitledArchivedTaskTitle}" and flagged for review`,
        );
      }
      for (const field of Object.keys(task))
        if (!Object.hasOwn(superProductivityTaskFields, field))
          unknownFields.set(field, (unknownFields.get(field) ?? 0) + 1);
      const projectId =
        typeof task.projectId === "string" ? task.projectId : null;
      const parentId = typeof task.parentId === "string" ? task.parentId : null;
      const repeatConfigId =
        typeof task.repeatCfgId === "string" ? task.repeatCfgId : null;
      // Archived history keeps unresolved references as provenance; a live
      // task with a missing reference still blocks.
      if (projectId !== null && !Object.hasOwn(projects, projectId)) {
        if (source.archived) {
          historicalReferences.push({
            kind: "project",
            sourceId: projectId,
            reason: "missing_from_export",
          });
          countHistorical("project");
        } else
          issue(
            "missing_project",
            id,
            "Referenced project is absent from the export",
          );
      }
      if (repeatConfigId !== null && !Object.hasOwn(repeats, repeatConfigId)) {
        if (source.archived) countHistorical("repeat_config");
        else
          issue(
            "missing_repeat_config",
            id,
            "Referenced repeat configuration is absent",
          );
      }
      if (
        source.archived &&
        repeatConfigId !== null &&
        !Object.hasOwn(repeats, repeatConfigId)
      )
        historicalReferences.push({
          kind: "repeat_config",
          sourceId: repeatConfigId,
          reason: "missing_from_export",
        });
      // Live and archived instances of an exported configuration link to its
      // series with their occurrence date and are never regenerated.
      let occurrenceDate: string | null = null;
      if (repeatConfigId !== null && Object.hasOwn(repeats, repeatConfigId)) {
        occurrenceDate = occurrenceDateOf(task, repeatConfigId, timeZone);
        if (parentId !== null)
          issue(
            "recurrence_unmappable",
            id,
            "A child task is linked to a repeat configuration; only top-level tasks can be recurring instances",
          );
        else if (occurrenceDate === null)
          issue(
            "recurrence_unmappable",
            id,
            "The instance's repeat day cannot be read from its ID or creation time",
          );
        else if (series.has(repeatConfigId)) {
          const key = `${repeatConfigId}:${occurrenceDate}`;
          if (occurrenceKeys.has(key))
            issue(
              "recurrence_duplicate_occurrence",
              id,
              `Another instance already has the ${occurrenceDate} occurrence; this one is linked as history and the date is not recreated`,
            );
          occurrenceKeys.add(key);
          links.push({
            taskSourceId: id,
            seriesSourceId: repeatConfigId,
            occurrenceDate,
          });
        }
      }
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
        else {
          let missingTag = false;
          for (const tagId of unique)
            if (source.archived && systemTagIds.has(tagId)) {
              if (tagId !== "TODAY")
                historicalReferences.push({
                  kind: "tag",
                  sourceId: tagId,
                  reason: "system_tag",
                });
            } else if (!Object.hasOwn(tags, tagId)) {
              if (source.archived) {
                missingTag = true;
                historicalReferences.push({
                  kind: "tag",
                  sourceId: tagId,
                  reason: "missing_from_export",
                });
              } else
                issue(
                  "missing_tag",
                  id,
                  "Referenced tag is absent from the export",
                );
            }
          if (missingTag) countHistorical("tag");
        }
      }
      const trackedMilliseconds = number(task.timeSpent, id, "timeSpent");
      const daily = object(task.timeSpentOnDay);
      if (task.timeSpentOnDay !== undefined && daily === undefined)
        issue(
          "invalid_time_history",
          id,
          "timeSpentOnDay must map calendar dates to milliseconds",
        );
      const dailyValues: Record<string, number> = {};
      if (daily !== undefined) {
        let total = 0;
        for (const [date, entry] of Object.entries(daily)) {
          const value = number(entry, id, "timeSpentOnDay");
          total += value;
          if (value > dayLimitMs)
            issue(
              "time_day_exceeds_day",
              id,
              "A daily timeSpentOnDay value exceeds 24 hours; correct it in Super Productivity before importing",
            );
          if (day(date, id, "timeSpentOnDay date") !== null && value > 0)
            dailyValues[date] = value;
        }
        if (!Number.isSafeInteger(total))
          issue(
            "time_total_overflow",
            id,
            "Daily tracked time exceeds safe integer precision",
          );
      }
      // Totals are reconciled once the hierarchy is known (ADR 0024).
      taskTimes.push({
        sourceId: id,
        parentId,
        store: source.store,
        trackedMilliseconds,
        daily: dailyValues,
      });
      const scheduledAt = timestamp(task.dueWithTime, id, "dueWithTime");
      const deadlineAt = timestamp(
        task.deadlineWithTime,
        id,
        "deadlineWithTime",
      );
      tasks.push({
        sourceId: id,
        title: blankArchivedTitle ? untitledArchivedTaskTitle : task.title,
        completed: task.isDone === true,
        archived: source.archived,
        store: source.store,
        review,
        historicalReferences,
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
        occurrenceDate,
      });
    }
  for (const [field, count] of unknownFields)
    issue(
      "unknown_task_field",
      null,
      `${String(count)} task records contain unreviewed field ${field}`,
    );
  const parentIds = new Set(tasks.map((task) => task.parentId));
  const byId = new Map(tasks.map((task) => [task.sourceId, task]));
  // A child shares its parent's lifecycle (ADR 0022). A child whose parent is
  // absent, or in the other lifecycle, becomes top-level with the source
  // parent kept as a historical reference. A live child with no parent blocks.
  const detached = new Set<string>();
  for (const task of tasks) {
    if (task.parentId === null) continue;
    const parent = byId.get(task.parentId);
    if (parent === undefined) {
      if (!task.archived) {
        issue(
          "missing_parent",
          task.sourceId,
          "Parent task is absent from all task stores",
        );
        continue;
      }
      task.historicalReferences.push({
        kind: "parent",
        sourceId: task.parentId,
        reason: "missing_from_export",
      });
      countHistorical("parent");
      detached.add(task.sourceId);
    } else if (parent.archived !== task.archived) {
      task.historicalReferences.push({
        kind: "parent",
        sourceId: task.parentId,
        reason: "lifecycle_mismatch",
      });
      issue(
        "historical_parent_detached",
        task.sourceId,
        task.archived
          ? "Archived child of a live parent is imported as a top-level archived task; the parent ID is kept as a historical reference"
          : "Live child of an archived parent is imported as a top-level task; the parent ID is kept as a historical reference",
      );
      detached.add(task.sourceId);
    }
  }
  for (const [parentId, refs] of children)
    for (const childId of refs) {
      const child = byId.get(childId);
      if (child === undefined) {
        // An archived parent's missing child is history already lost from
        // the export; the parent still imports. A live one blocks.
        if (byId.get(parentId)?.archived === true) countHistorical("child");
        else
          issue(
            "missing_child",
            parentId,
            "Listed child is absent from all task stores",
          );
      } else if (child.parentId !== parentId)
        issue(
          "hierarchy_mismatch",
          childId,
          "Child parentId disagrees with the parent's subTaskIds",
        );
    }
  for (const task of tasks)
    if (
      task.parentId !== null &&
      !detached.has(task.sourceId) &&
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
  // Tadooer supports exactly two levels (ADR 0018); a deeper source chain
  // would need flattening, which the importer refuses to guess.
  for (const task of tasks) {
    if (detached.has(task.sourceId)) continue;
    const parent = task.parentId === null ? undefined : byId.get(task.parentId);
    if (
      parent?.parentId != null &&
      !detached.has(parent.sourceId) &&
      parent.parentId !== task.sourceId &&
      parent.parentId !== parent.sourceId
    )
      issue(
        "hierarchy_depth_unsupported",
        task.sourceId,
        "Child tasks nest more than two levels; move them under a top-level task before importing",
      );
  }
  // [plural, singular] predicates for one aggregated finding per kind.
  const historicalSummary: Readonly<Record<string, readonly [string, string]>> =
    {
      project: ["reference", "references"],
      tag: ["reference", "references"],
      repeat_config: ["reference", "references"],
      parent: ["reference", "references"],
      child: ["list", "lists"],
    };
  const historicalObject: Readonly<Record<string, string>> = {
    project: "projects absent from the export",
    tag: "tags absent from the export",
    repeat_config: "repeat configurations absent from the export",
    parent: "parent tasks absent from the export and are imported at top level",
    child: "child tasks absent from the export",
  };
  for (const [kind, count] of historicalCounts)
    issue(
      "historical_reference",
      null,
      `${count.toLocaleString("en-US")} archived task${count === 1 ? "" : "s"} ${historicalSummary[kind]?.[count === 1 ? 1 : 0] ?? "reference"} ${historicalObject[kind] ?? kind}; source IDs are kept as read-only historical references`,
    );
  // Work history (ADR 0024): each tracked millisecond is imported once, as a
  // leaf day or as the part of a parent day its children do not explain.
  const reconciled = reconcileTaskTime(taskTimes, issue);
  const workContexts = readWorkContexts(
    [
      { name: "timeTracking", value: data.timeTracking },
      {
        name: "archiveYoung",
        value: object(data.archiveYoung)?.timeTracking,
      },
      { name: "archiveOld", value: object(data.archiveOld)?.timeTracking },
    ],
    {
      projects,
      tags: Object.fromEntries(
        Object.entries(tags).filter(([id]) => !systemTagIds.has(id)),
      ),
    },
    issue,
  );
  const time = { ...reconciled.totals, workContextDays: workContexts.length };
  if (
    time.taskDayEntries + time.parentResidualEntries + time.workContextDays >
      0 ||
    time.sourceLeafMs > 0
  )
    issue("time_reconciliation", null, reconciliationSummary(time));
  // Counters and metric days (ADR 0025): definitions, day values and
  // evaluations with their provenance; streaks are derived, not imported.
  const counterIds = (value: unknown): string[] => {
    const ids = object(value)?.ids;
    return Array.isArray(ids)
      ? [...new Set(ids.filter((id): id is string => typeof id === "string"))]
      : [];
  };
  const counters = readSimpleCounters(
    entities(data.simpleCounter, "simpleCounter"),
    counterIds(data.simpleCounter),
    timeZone,
    issue,
  );
  const evaluations = readMetrics(
    entities(data.metric, "metric"),
    counterIds(data.metric),
    issue,
  );
  const counterTotals = counterReconciliation(counters, evaluations);
  if (counterTotals.definitions + counterTotals.evaluations > 0)
    issue(
      "counter_reconciliation",
      null,
      counterReconciliationSummary(counterTotals, counters),
    );
  issue(
    "preview_only",
    null,
    "Inventory only: no data was written. Keep the original export for the later transactional import.",
  );
  const preview: SuperProductivityPreview = {
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
      time,
      counters: counterTotals,
    },
    tasks,
    issues,
  };
  return {
    preview,
    recurrence: {
      series: [...series.values()],
      links,
    },
    timeEntries: reconciled.entries,
    workContexts,
    counters,
    evaluations,
    plugins,
  };
};
