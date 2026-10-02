import type {
  AutomationPreviewCommand,
  LiveSyncResourceFamily,
} from "@suite/contracts";

/**
 * Which resource families a mutating request touches (ADR 0045). The sync
 * feed covers tasks, projects, tags, checklist items, notes (ADR 0046),
 * templates, template sets, choice pools, planning placeholders, habits and
 * the active session; a change there is announced as `changes` from the feed
 * head. Everything else an owner can change is outside the feed (ADR 0033)
 * and is announced as `resources` with the families named here.
 *
 * A record kind that moves into the feed changes its rules to `feed` and its
 * automation operations to `feedOnly`; its family is then never emitted.
 *
 * `resource-families.test.ts` reads the path literals and patterns of every
 * route handler and fails when one of them has no entry in this table, and
 * when an automation operation has no entry in `automationOperationFamilies`.
 */

export type MutatingMethod = "POST" | "PUT" | "PATCH" | "DELETE";

export type RouteClassification =
  /** Emits `resources` with these families after a successful request. */
  | {
      readonly kind: "families";
      readonly families: readonly LiveSyncResourceFamily[];
    }
  /** Every record the route writes is in the sync feed. */
  | { readonly kind: "feed" }
  /** The route changes no owner record that another device displays. */
  | { readonly kind: "none"; readonly because: string }
  /** Automation: the executed operation decides, not the path. */
  | { readonly kind: "automation" };

interface RouteRule {
  /** `*` covers the four mutating methods. `GET` marks a mutating read. */
  readonly methods: "*" | readonly (MutatingMethod | "GET")[];
  readonly path: RegExp;
  readonly classification: RouteClassification;
}

const uuid = "[0-9a-f-]{36}";
const date = "\\d{4}-\\d{2}-\\d{2}";

const path = (pattern: string): RegExp => new RegExp(`^/api/${pattern}$`);

const families = (
  methods: RouteRule["methods"],
  pattern: string,
  ...names: LiveSyncResourceFamily[]
): RouteRule => ({
  methods,
  path: path(pattern),
  classification: { kind: "families", families: names },
});

const feed = (methods: RouteRule["methods"], pattern: string): RouteRule => ({
  methods,
  path: path(pattern),
  classification: { kind: "feed" },
});

const none = (pattern: string, because: string): RouteRule => ({
  methods: "*",
  path: path(pattern),
  classification: { kind: "none", because },
});

const readOnly = "read-only route";
const identity = "owner setup and session; ended sessions close the stream";
const preview = "preview or probe; nothing is stored for another device";

/** First match wins, so a method-specific rule precedes the `*` rule. */
const routeRules: readonly RouteRule[] = [
  // Process and identity.
  none("(health|metrics|build|ready)", readOnly),
  none("setup(/status)?", identity),
  none("auth/(login|session|logout)", identity),
  none(
    `clients(/${uuid})?`,
    "device registry has no resource family; a revoked client's stream ends with bye",
  ),
  // Sync protocol: a round's operations are feed records.
  feed("*", "sync/round"),
  none("sync/(snapshot|events)", readOnly),

  // Tasks. Reminder settings and the planned day or time are written online
  // through PATCH and the time-block routes (ADR 0020, ADR 0009).
  families(["PATCH"], `tasks/${uuid}`, "task_planning"),
  families("*", `tasks/${uuid}/time-block`, "task_planning", "calendar"),
  feed("*", "tasks"),
  feed("*", `tasks/${uuid}`),
  feed("*", `tasks/${uuid}/(complete|reopen|restore)`),
  feed("*", "tasks/batch"),
  none("tasks/capture-preview", preview),
  none("tasks/(recovery|history)", readOnly),
  families("*", `tasks/${uuid}/(archive|unarchive)`, "archive"),
  feed("*", `tasks/${uuid}/(children|move)`),
  feed("*", `tasks/${uuid}/subtasks`),
  feed("*", `subtasks/${uuid}`),
  // Leaving a project also leaves its backlog, which is outside the feed.
  families("*", `tasks/${uuid}/project`, "organization"),
  feed("*", `tasks/${uuid}/tags`),
  families(
    "*",
    `tasks/${uuid}/(links|attachments|attachments/${uuid}|issue-link/${uuid})`,
    "task_links",
  ),
  families("*", "capture-preferences", "capture_preferences"),

  // Projects and tags: order, backlog and menu visibility are online-only.
  families(
    "*",
    `(projects|tags)(/order|/${uuid}|/${uuid}/backlog)?`,
    "organization",
  ),
  // ADR 0046: notes are feed records; the `notes` family is retired.
  feed("*", `notes(/order|/${uuid})?`),

  // Reusable work, pools, placeholders and habits are feed entities.
  feed("*", `templates(/${uuid}|/${uuid}/(archive|instantiate|pool-slots))?`),
  feed("*", `templates/from-task/${uuid}`),
  feed("*", `template-sets(/${uuid}/instantiate)?`),
  feed("*", `pools(/${uuid}|/${uuid}/items/${uuid}/completions)?`),
  feed("*", `placeholders(/${uuid}/resolve)?`),
  none(`placeholders/${uuid}/suggestion`, readOnly),
  feed("*", `habits(/${uuid}(/(archive|restore|occurrences))?)?`),

  // Focus: the active session is a feed entity; its tracked time, focus
  // preferences, plan and reminders are not.
  families("*", "active-session(/command)?", "focus", "time_entries"),
  families(
    "*",
    "focus/(preferences|timer|plan|idle|break-reminder/snooze)",
    "focus",
    "time_entries",
  ),
  families("*", `time/entries(/${uuid})?`, "time_entries"),
  none("time/report", readOnly),
  families("*", `counters(/${uuid}(/days/${date}|/stopwatch)?)?`, "counters"),
  families("*", `evaluations(/${date})?`, "evaluations"),
  families(
    "*",
    `recurring-series(/${uuid}(/state|/occurrences/[0-9-]{10})?)?`,
    "recurrence",
  ),

  // Day orders, boards, sections, saved views and menu folders.
  families("*", `day-orders(/${date})?`, "day_orders"),
  families("*", `day-orders/${date}/tasks`, "day_orders", "task_planning"),
  families(
    "*",
    `boards(/order|/${uuid}(/panels/${uuid}/(order|tasks))?)?`,
    "boards",
  ),
  families("*", `(sections|task-views)(/order|/${uuid})?`, "boards"),
  families("*", `menu-folders(/order|/${uuid})?`, "boards", "organization"),

  // Preferences.
  families("*", "application/preferences", "application_preferences"),
  families("*", "planning/preferences", "planning_preferences"),
  families("*", "notifications/preferences", "notification_preferences"),
  families("*", "notifications/test", "notification_preferences"),
  none("notifications/status", readOnly),
  none("(planner|day-plan)", readOnly),

  // Calendars, connectors, publication and the bridge.
  families("*", "connectors/baikal", "connectors", "calendar"),
  none("connectors/baikal/probe", preview),
  families("*", "connectors/google", "connectors", "calendar"),
  families("*", "connectors/google/(authorize|write-consent)", "connectors"),
  // The OAuth callback connects the account in a GET request.
  families(["GET"], "connectors/google/callback", "connectors", "calendar"),
  families("*", "connectors/google/callback", "connectors", "calendar"),
  families("*", "connectors/google/sync", "connectors", "calendar"),
  families(
    "*",
    `calendar-subscriptions(/events|/${uuid}(/(refresh|events/hidden|events/convert|events/dismiss))?)?`,
    "calendar_subscriptions",
    "calendar",
  ),
  families("*", "calendar-bridge/mappings(/preview)?", "calendar_bridge"),
  none("calendar-bridge/overview", readOnly),
  families(
    "*",
    `calendar-bridge/mappings/${uuid}(/(run|links|review)|/links/${uuid}/(approve|decline)-deletion|/conflicts/${uuid}/resolve)?`,
    "calendar_bridge",
    "calendar",
  ),
  families("*", `calendar-feeds(/${uuid})?`, "publication"),
  none(`calendars/${uuid}/export\\.ics`, readOnly),

  // Imports and restore replace or add records across families.
  families("*", `imports/preview`, "calendar"),
  families("*", `imports/${uuid}(/apply)?`, "all"),
  none("imports/super-productivity/preview", preview),
  families("*", "imports/super-productivity/apply", "all"),
  none("data/(export|restore/preview)", preview),
  families("*", "data/restore/apply", "all"),
  families(
    "*",
    "plugin-data(/(entries|plugins)/[0-9a-f-]{36})?",
    "plugin_data",
  ),

  // Automation. Owner-managed tokens and the audit list are one family; a
  // bearer request is classified by the operation it executes.
  families("*", `automation/tokens(/${uuid})?`, "automation"),
  none("automation/audit", readOnly),
  {
    methods: "*",
    path: /^\/api\/automation\/v1\//,
    classification: { kind: "automation" },
  },
];

/**
 * Classification of one request, or undefined when no rule names the path.
 * A `GET` has a classification only when a rule marks it as mutating.
 */
export const classifyLiveSyncRoute = (
  method: string,
  pathname: string,
): RouteClassification | undefined => {
  const mutating =
    method === "POST" ||
    method === "PUT" ||
    method === "PATCH" ||
    method === "DELETE";
  if (!mutating && method !== "GET") return undefined;
  for (const rule of routeRules) {
    if (
      rule.methods === "*"
        ? !mutating
        : !rule.methods.some((allowed) => allowed === method)
    )
      continue;
    if (rule.path.test(pathname)) return rule.classification;
  }
  return undefined;
};

/** Families sent when a successful mutation has no classification. */
export const unclassifiedRouteFamilies: readonly LiveSyncResourceFamily[] = [
  "all",
];

type AutomationOperation = AutomationPreviewCommand["operation"];

const feedOnly: readonly LiveSyncResourceFamily[] = [];

/**
 * Families touched when an automation operation is executed. An empty list
 * means every record it writes is in the sync feed. Every execution also
 * adds an audit row, so the caller appends `automation`.
 */
export const automationOperationFamilies: Readonly<
  Record<AutomationOperation, readonly LiveSyncResourceFamily[]>
> = {
  "planning.update_preferences": ["planning_preferences"],
  "application.update_preferences": ["application_preferences"],
  "notifications.send_test": ["notification_preferences"],
  "notifications.update_preferences": ["notification_preferences"],
  "subtasks.mutate": feedOnly,
  "projects.mutate": ["organization"],
  "projects.reorder": ["organization"],
  "projects.set_backlog": ["organization"],
  "tags.mutate": ["organization"],
  "tags.reorder": ["organization"],
  "notes.mutate": feedOnly,
  "task_links.mutate": ["task_links"],
  "tasks.assign_project": ["organization"],
  "tasks.set_tags": feedOnly,
  "tasks.hierarchy": feedOnly,
  "tasks.create": feedOnly,
  "tasks.create_many": feedOnly,
  "tasks.update": ["task_planning"],
  "tasks.set_completed": feedOnly,
  "tasks.delete": feedOnly,
  "tasks.restore": feedOnly,
  "tasks.archive": ["archive"],
  "tasks.unarchive": ["archive"],
  "recurrence.create": ["recurrence"],
  "recurrence.update": ["recurrence"],
  "recurrence.set_state": ["recurrence"],
  "recurrence.occurrence": ["recurrence"],
  "time_entries.mutate": ["time_entries"],
  "counters.mutate": ["counters"],
  "counters.record": ["counters"],
  "evaluations.write": ["evaluations"],
  "day_order.reorder": ["day_orders"],
  "boards.mutate": ["boards"],
  "sections.mutate": ["boards"],
  "task_views.set": ["boards"],
  "menu_folders.mutate": ["boards", "organization"],
  "calendar_subscriptions.refresh": ["calendar_subscriptions", "calendar"],
  "calendar_subscriptions.convert_event": [
    "calendar_subscriptions",
    "calendar",
  ],
  "calendar_subscriptions.hide_event": ["calendar_subscriptions", "calendar"],
  "imports.apply": ["all"],
  "calendar_feeds.revoke": ["publication"],
  "connectors.resync": ["connectors", "calendar"],
  "calendar_bridge.decide_deletion": ["calendar_bridge", "calendar"],
  "calendar_bridge.resolve_conflict": ["calendar_bridge", "calendar"],
  "schedule.create_time_block": ["task_planning", "calendar"],
  "schedule.move_time_block": ["task_planning", "calendar"],
  "schedule.remove_time_block": ["task_planning", "calendar"],
  "focus.start": ["focus", "time_entries"],
  "focus.pause": ["focus", "time_entries"],
  "focus.resume": ["focus", "time_entries"],
  "focus.start_break": ["focus", "time_entries"],
  "focus.end_break": ["focus", "time_entries"],
  "focus.complete": ["focus", "time_entries"],
  "focus.takeover": ["focus", "time_entries"],
  "focus.update_preferences": ["focus"],
  "focus.idle_disposition": ["focus", "time_entries"],
  "templates.instantiate": feedOnly,
  "template_sets.instantiate": feedOnly,
  "placeholders.resolve": feedOnly,
  "templates.mutate": feedOnly,
  "template_sets.create": feedOnly,
  "pools.mutate": feedOnly,
  "placeholders.create": feedOnly,
  "habits.mutate": feedOnly,
};
