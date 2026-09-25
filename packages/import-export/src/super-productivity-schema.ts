/**
 * Reviewed dispositions for every Super Productivity 19.1.0 export section and
 * entity field. docs/product/super-productivity-parity.json must reference each
 * key; the drift test rejects additions that have not been classified.
 *
 * - applied: mapped into Tadooer records by the core apply path.
 * - parity: inventoried by the preview, which blocks apply with a parity issue.
 * - retained: not applied; copied into the import provenance JSON.
 * - blocked: a populated value blocks apply as unsupported data.
 * - configuration: preferences or view setup; reported, never applied, and does
 *   not block apply. The original export remains the source for later parity.
 * - ignored: derived or transient view state with no independent user data.
 */
export type SectionDisposition =
  "applied" | "parity" | "blocked" | "configuration";
export type FieldDisposition =
  "applied" | "parity" | "retained" | "blocked" | "ignored";

export const superProductivitySections = {
  task: "applied",
  project: "applied",
  tag: "applied",
  taskRepeatCfg: "parity",
  archiveYoung: "parity",
  archiveOld: "parity",
  note: "blocked",
  section: "blocked",
  reminders: "blocked",
  metric: "blocked",
  timeTracking: "blocked",
  pluginUserData: "blocked",
  // Counter definitions are configuration; recorded values block (see preview).
  simpleCounter: "blocked",
  planner: "configuration",
  boards: "configuration",
  menuTree: "configuration",
  globalConfig: "configuration",
  issueProvider: "configuration",
  pluginMetadata: "configuration",
} as const satisfies Record<string, SectionDisposition>;

export const superProductivityTaskFields = {
  id: "applied",
  title: "applied",
  notes: "applied",
  projectId: "applied",
  tagIds: "applied",
  isDone: "applied",
  doneOn: "applied",
  created: "applied",
  dueWithTime: "applied",
  deadlineDay: "applied",
  deadlineWithTime: "applied",
  timeEstimate: "applied",
  parentId: "applied",
  subTaskIds: "applied",
  repeatCfgId: "parity",
  timeSpent: "parity",
  timeSpentOnDay: "parity",
  dueDay: "parity",
  modified: "ignored",
  hasPlannedTime: "ignored",
  _hideSubTasksMode: "ignored",
  remindAt: "blocked",
  deadlineRemindAt: "blocked",
  reminderId: "blocked",
  attachments: "blocked",
  issueId: "blocked",
  issueProviderId: "blocked",
  issueType: "blocked",
  issueWasUpdated: "blocked",
  issueLastUpdated: "blocked",
  issueAttachmentNr: "blocked",
  issueTimeTracked: "blocked",
  issuePoints: "blocked",
  issueLastSyncedValues: "blocked",
  // Pre-v14 schedule; Super Productivity migrates it to dueWithTime on import.
  plannedAt: "blocked",
  // Leaked TaskWithSubTasks view copy; the children are exported as tasks.
  subTasks: "ignored",
} as const satisfies Record<string, FieldDisposition>;

export const superProductivityProjectFields = {
  id: "applied",
  title: "applied",
  created: "retained",
  updated: "retained",
  icon: "retained",
  theme: "retained",
  taskIds: "retained",
  isHiddenFromMenu: "retained",
  isEnableBacklog: "retained",
  advancedCfg: "retained",
  backlogTaskIds: "blocked",
  noteIds: "blocked",
  notes: "blocked",
  isArchived: "blocked",
  isDone: "blocked",
  doneOn: "blocked",
  // Legacy per-project provider configuration can hold credentials.
  issueIntegrationCfgs: "ignored",
} as const satisfies Record<string, FieldDisposition>;

export const superProductivityTagFields = {
  id: "applied",
  title: "applied",
  created: "retained",
  updated: "retained",
  modified: "retained",
  color: "retained",
  icon: "retained",
  theme: "retained",
  taskIds: "retained",
  advancedCfg: "retained",
  notes: "blocked",
  isArchived: "blocked",
} as const satisfies Record<string, FieldDisposition>;

/** False for absent, empty or default-off values that carry no user data. */
export const populated = (value: unknown): boolean => {
  if (value === undefined || value === null || value === "" || value === false)
    return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
};

export const fieldsWith = (
  table: Readonly<Record<string, FieldDisposition>>,
  ...dispositions: readonly FieldDisposition[]
): string[] =>
  Object.entries(table)
    .filter(([, disposition]) => dispositions.includes(disposition))
    .map(([field]) => field);
