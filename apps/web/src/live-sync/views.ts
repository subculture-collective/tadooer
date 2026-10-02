import { useEffect, useRef, useState } from "react";
import type { LiveSyncResourceFamily } from "@suite/contracts";
import { noteBackgroundReads } from "../api.ts";

/**
 * Online views the web app can refetch when a live sync `resources` hint
 * arrives (ADR 0045). A view registers its existing loader while it is
 * mounted and loaded; a view that is not open has no entry and costs nothing.
 */
export const liveViews = [
  /** Links and attachments of an expanded task. */
  "taskLinks",
  /** Archived tasks on History. */
  "history",
  /** Recurring series manager on Tasks, once opened. */
  "recurringSeries",
  /**
   * Time report on Worklog. Also reloaded when a sync round delivers a
   * stored time entry (ADR 0050), since those no longer send a hint.
   */
  "worklog",
  /** Time-spent totals used by a saved task view's sort or filter. */
  "timeSpent",
  /** Counters with their history, and the daily evaluations beside them. */
  "counters",
  /** Imported plugin data on Connections. */
  "pluginData",
  /** Board list and the open board. */
  "boards",
  /** Saved task views (sort, filter, grouping). */
  "taskViews",
  /** Sections of the open task context. */
  "sections",
  /** Menu folders on Tasks. */
  "menuFolders",
  /** Focus preferences. */
  "focusPreferences",
  /** Focus timer of the active session. */
  "focusTimer",
  /** Application preferences (theme, shortcuts, start page). */
  "applicationPreferences",
  /** Planning preferences held by the app shell. */
  "planningPreferences",
  /** Day plan held by the app shell. */
  "dayPlan",
  /** Notification preferences and delivery status. */
  "notificationPreferences",
  /** Capture link preference in the capture form. */
  "capturePreferences",
  /** Planner window: the app shell's week or the Planner page's range. */
  "planner",
  /** Baikal and Google connector status. */
  "connectors",
  /** Calendar subscriptions and their upcoming events. */
  "calendarSubscriptions",
  /** Calendar bridge mappings and open reviews. */
  "calendarBridge",
  /** Published calendar feeds on Connections. */
  "calendarFeeds",
  /** Assistant access tokens, once listed. */
  "automationTokens",
  /** Template library and sets. Feed records that the app reads online. */
  "templates",
  /** Choice pools and planning placeholders, read online like templates. */
  "choicePools",
] as const;
export type LiveView = (typeof liveViews)[number];

/**
 * Which views each resource family refetches. Every family of the contract
 * has an entry; a family with no web view would map to an empty list.
 */
export const liveSyncFamilyViews: Readonly<
  Record<LiveSyncResourceFamily, readonly LiveView[]>
> = {
  // A restore, import or other wholesale change: everything that is loaded.
  all: liveViews,
  // Retired (ADR 0046): notes are feed records read from the offline cache.
  // The server no longer emits this family; a hint from an older server
  // refetches nothing, and the next sync round delivers the notes.
  notes: [],
  task_links: ["taskLinks"],
  // Planned days and reminders shape the day plan.
  task_planning: ["dayPlan"],
  archive: ["history"],
  recurrence: ["recurringSeries"],
  // Emitted by focus commands only: stored time entries are feed records
  // (ADR 0050) and reload these views through `refetchViews`.
  time_entries: ["worklog", "timeSpent"],
  counters: ["counters"],
  // Daily evaluations are loaded with the counters page.
  evaluations: ["counters"],
  plugin_data: ["pluginData"],
  // Retired (ADR 0050): saved day orders are feed records read from the
  // offline cache, like notes.
  day_orders: [],
  // The server reports sections and saved views under `boards`.
  boards: ["boards", "taskViews", "sections", "menuFolders"],
  // ADR 0019 records that are not feed entities: views, sections, folders.
  organization: ["taskViews", "sections", "menuFolders"],
  focus: ["focusPreferences", "focusTimer"],
  application_preferences: ["applicationPreferences"],
  // The day plan is computed from the planning preferences.
  planning_preferences: ["planningPreferences", "dayPlan"],
  notification_preferences: ["notificationPreferences"],
  capture_preferences: ["capturePreferences"],
  calendar: ["planner", "dayPlan"],
  calendar_subscriptions: ["calendarSubscriptions", "planner"],
  calendar_bridge: ["calendarBridge", "planner"],
  // The connectors refetch also reloads or clears the shell's planner window.
  connectors: ["connectors", "dayPlan"],
  // Published calendar feeds are the only publication the web app lists.
  publication: ["calendarFeeds"],
  automation: ["automationTokens"],
};

type Refetch = () => void | Promise<void>;

/** The loaders of the views that are currently open in this tab. */
export class LiveViewRegistry {
  readonly #views = new Map<LiveView, Set<Refetch>>();

  register(view: LiveView, refetch: Refetch): () => void {
    const entries = this.#views.get(view) ?? new Set<Refetch>();
    this.#views.set(view, entries);
    entries.add(refetch);
    return () => {
      entries.delete(refetch);
      if (entries.size === 0) this.#views.delete(view);
    };
  }

  /**
   * Refetches the loaded views of the named families and returns the views
   * it refetched. Nothing happens when this client caused the change: it
   * already shows what it wrote.
   */
  refetch(
    families: readonly LiveSyncResourceFamily[],
    source: {
      readonly sourceClientId: string | null;
      readonly ownClientId: string | undefined;
    },
  ): readonly LiveView[] {
    if (
      source.sourceClientId !== null &&
      source.sourceClientId === source.ownClientId
    )
      return [];
    return this.refetchViews([
      ...new Set(families.flatMap((family) => liveSyncFamilyViews[family])),
    ]);
  }

  /**
   * Refetches the named views that are loaded and returns those it
   * refetched. Used directly for views that read a server projection of a
   * feed kind: they reload when a sync round delivered that kind (ADR 0050).
   */
  refetchViews(views: readonly LiveView[]): readonly LiveView[] {
    // The loaders run now or on the next render; either way within the
    // window, and their reads must not count as owner activity.
    noteBackgroundReads();
    const refetched: LiveView[] = [];
    for (const view of views) {
      const entries = this.#views.get(view);
      if (entries === undefined) continue;
      refetched.push(view);
      for (const refetch of entries) {
        // A failed refetch leaves the view as it was; its own loader reports
        // errors where it already does.
        try {
          void Promise.resolve(refetch()).catch(() => undefined);
        } catch {
          // Synchronous failure: same handling.
        }
      }
    }
    return refetched;
  }
}

/** One registry per tab. */
export const liveViewRegistry = new LiveViewRegistry();

/**
 * Registers a view's loader while the component is mounted and `enabled`
 * (pass false until the view has loaded once or while it is offline). The
 * latest `refetch` closure is used.
 */
export const useLiveRefetch = (
  view: LiveView,
  refetch: Refetch,
  enabled = true,
  registry: LiveViewRegistry = liveViewRegistry,
): void => {
  const latest = useRef(refetch);
  latest.current = refetch;
  useEffect(() => {
    if (!enabled) return;
    return registry.register(view, () => latest.current());
  }, [enabled, registry, view]);
};

/**
 * For views that load inside an effect: returns a number that changes when
 * the view should load again. Add it to that effect's dependencies.
 */
export const useLiveRevision = (view: LiveView, enabled = true): number => {
  const [revision, setRevision] = useState(0);
  useLiveRefetch(
    view,
    () => {
      setRevision((current) => current + 1);
    },
    enabled,
  );
  return revision;
};
