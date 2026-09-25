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
  // Archived tasks apply as read-only history since #38 (ADR 0022). Their
  // timeTracking part still blocks until work history parity (#41).
  archiveYoung: "applied",
  archiveOld: "applied",
  // Notes and menu order apply since #28 (ADR 0019); menuTree folders do not.
  note: "applied",
  menuTree: "applied",
  section: "blocked",
  reminders: "blocked",
  metric: "blocked",
  timeTracking: "blocked",
  pluginUserData: "blocked",
  // Counter definitions are configuration; recorded values block (see preview).
  simpleCounter: "blocked",
  planner: "configuration",
  boards: "configuration",
  globalConfig: "configuration",
  issueProvider: "configuration",
  pluginMetadata: "configuration",
} as const satisfies Record<string, SectionDisposition>;

/**
 * Keys of an archiveYoung/archiveOld section (ArchiveModel). `task` applies;
 * populated `timeTracking` blocks (#41); flush timestamps are transient.
 */
export const superProductivityArchiveKeys = {
  task: "applied",
  timeTracking: "parity",
  lastTimeTrackingFlush: "ignored",
  lastFlush: "ignored",
} as const satisfies Record<string, FieldDisposition>;

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
  // Date-only plan; superseded when dueWithTime is also set (ADR 0020).
  dueDay: "applied",
  deadlineDay: "applied",
  deadlineWithTime: "applied",
  timeEstimate: "applied",
  parentId: "applied",
  subTaskIds: "applied",
  repeatCfgId: "parity",
  timeSpent: "parity",
  timeSpentOnDay: "parity",
  modified: "ignored",
  hasPlannedTime: "ignored",
  _hideSubTasksMode: "ignored",
  // Applied only when the absolute time is an exact supported offset before
  // dueWithTime / deadlineWithTime; otherwise apply is blocked (ADR 0020).
  remindAt: "applied",
  deadlineRemindAt: "applied",
  // Legacy link into the reminders section, which stays blocked.
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
  // On an archived task it is inert history and kept in provenance (ADR 0022).
  plannedAt: "blocked",
  // Leaked TaskWithSubTasks view copy; the children are exported as tasks.
  subTasks: "ignored",
} as const satisfies Record<string, FieldDisposition>;

export const superProductivityProjectFields = {
  id: "applied",
  title: "applied",
  created: "applied",
  updated: "retained",
  icon: "applied",
  // Only a valid theme.primary becomes the project colour; the rest of the
  // theme (backgrounds, hues, contrast) is provenance only.
  theme: "retained",
  // Task order inside a project has no Tadooer equivalent yet.
  taskIds: "retained",
  isHiddenFromMenu: "applied",
  isEnableBacklog: "applied",
  advancedCfg: "retained",
  backlogTaskIds: "applied",
  // Orders the project's notes; note association comes from note.projectId.
  noteIds: "applied",
  // Legacy free-text project notes predate the note section.
  notes: "blocked",
  isArchived: "applied",
  isDone: "applied",
  doneOn: "applied",
  // Legacy per-project provider configuration can hold credentials.
  issueIntegrationCfgs: "ignored",
} as const satisfies Record<string, FieldDisposition>;

export const superProductivityTagFields = {
  id: "applied",
  title: "applied",
  created: "applied",
  updated: "retained",
  modified: "retained",
  color: "applied",
  icon: "applied",
  // theme.primary is the colour fallback when color is empty.
  theme: "retained",
  taskIds: "retained",
  advancedCfg: "retained",
  notes: "blocked",
  isArchived: "applied",
} as const satisfies Record<string, FieldDisposition>;

export const superProductivityNoteFields = {
  id: "applied",
  projectId: "applied",
  content: "applied",
  isPinnedToToday: "applied",
  created: "applied",
  modified: "retained",
  isLock: "retained",
  backgroundColor: "retained",
  // Image notes reference files or URLs that the import cannot carry.
  imgUrl: "blocked",
} as const satisfies Record<string, FieldDisposition>;

/**
 * Super Productivity system tags. They are derived views or board state, never
 * ordinary imported tags: TODAY is the Today view (#29) and the others belong
 * to the Eisenhower/Kanban boards (#63).
 */
export const superProductivitySystemTagIds = [
  "TODAY",
  "EM_URGENT",
  "EM_IMPORTANT",
  "KANBAN_IN_PROGRESS",
] as const;

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
