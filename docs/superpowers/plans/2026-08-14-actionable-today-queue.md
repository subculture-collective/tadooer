# Actionable Today Queue Implementation Plan

> **For agentic workers:** Execute this plan task-by-task. Recommended path:
> dispatch a fresh subagent per task, review each result with `review-quality`,
> then continue. For complex multi-agent splits, use
> `parallel-feature-development`, `team-composition-patterns`, and
> `team-communication-protocols`. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Turn Today into the owner's primary daily workflow by presenting an automatic, actionable queue for overdue and today-scheduled tasks, with a separate unscheduled planning section.

**Architecture:** Add a pure timezone-aware task classifier to `@suite/domain`, then compose existing task-sync, time-block, and active-session commands in focused React components. Do not add task priority, rank, due-date, or recurrence persistence. Cache only the owner's planning preferences in existing IndexedDB metadata so a cold offline start can classify local tasks without using the browser timezone; keep calendar and focus mutations online-only.

**Tech Stack:** TypeScript 5.9, React 19, Zod 4, IndexedDB, Vitest 4, Vite 8, pnpm 11

---

## Agreed Product Contract

### Queue membership

At logical timestamp `at`, interpreted using the owner's configured IANA time zone:

- **Overdue:** open, non-deleted tasks with `plannedStart < at`.
- **Scheduled today:** open, non-deleted tasks with `at <= plannedStart < end of the owner's civil day`.
- **Planning:** open, non-deleted tasks with no `plannedStart`.
- **Future:** open, non-deleted tasks with `plannedStart >= end of the owner's civil day`; hide these rows from Today and show only a count/link to Tasks.
- Sort Overdue and Scheduled today by `plannedStart`, then UUID. Sort Planning by UUID to preserve the current deterministic fallback without introducing rank semantics.
- Completed tasks leave their active section immediately. Tasks completed during the current mounted Today view appear in a transient **Completed just now** region with a Reopen action.

### Actions available from Today

- Capture a task with the existing title, notes, and estimate operation.
- Complete or reopen through the existing local-first task status operation.
- Schedule, move, or remove the single Baïkal-backed Time Block through the existing conditional-write operations.
- Start or control the existing server-authoritative Active Session.
- Calendar and focus actions remain visible but unavailable with an explanation while offline; they are never queued locally.
- Completing an Active Session and completing its Task remain separate operations in this slice.

### Non-goals

- Persisted Today membership, ranking, priority, due dates, dependencies, or recurring tasks.
- Automatic scheduling, collision avoidance, drag-and-drop, or calendar authority changes.
- Offline Active Sessions or offline calendar mutation queues.
- Duplicating projects, tags, checklists, templates, recovery, or the full task editor on Today.
- Changing automation/MCP contracts or `DayPlanResponse.orderedTasks` semantics.

## File Map

| File | Responsibility |
|---|---|
| `packages/domain/src/day-planning.ts` | Pure owner-timezone Today classification. |
| `packages/domain/src/day-planning.test.ts` | Boundary, ordering, completion, and DST classification tests. |
| `apps/web/package.json` / `pnpm-lock.yaml` | Add the existing workspace `@suite/domain` package as a web dependency. |
| `apps/web/src/local-store.ts` | Cache/load planning preferences in the existing IndexedDB metadata store. |
| `apps/web/src/local-store.test.ts` | Verify preference round-trip and absent-cache behavior. |
| `apps/web/src/time-block-form.tsx` | Shared accessible schedule/move/remove disclosure used by Tasks and Today. |
| `apps/web/src/time-block-form.test.tsx` | Server-rendered schedule and offline-state contract tests. |
| `apps/web/src/today-queue.tsx` | Hydrate classifier IDs, render sections/task rows, and track recently completed tasks. |
| `apps/web/src/today-queue.test.tsx` | Queue hierarchy, hidden future work, action labels, and offline-state tests. |
| `apps/web/src/focus-panel.tsx` | Support row-driven focus starts without retaining a duplicate all-task picker. |
| `apps/web/src/pages/TasksPage.tsx` | Replace duplicated time-block markup with `TimeBlockForm`. |
| `apps/web/src/pages/TodayPage.tsx` | Compose header, capture, focus, queue, planning, and secondary week context. |
| `apps/web/src/app.tsx` | Supply callbacks/capabilities, maintain a logical clock, persist preferences without authenticated-state overwrite, and render Today during cold offline start. |
| `apps/web/src/app.test.tsx` | Authenticated and cold-offline Today integration coverage. |
| `apps/web/src/styles.css` | Responsive hierarchy, row/action states, focus treatment, contrast, and touch targets. |
| `package.json` | Add the focused `test:phase13` command. |
| `docs/ROADMAP.md` | Record Phase 13 scope, non-goals, and acceptance evidence. |
| `docs/product/feature-prioritization.md` | Mark Actionable Today Queue as the selected `Next` wave. |

---

### Task 1: Add deterministic Today classification

**Files:**

- Modify: `packages/domain/src/day-planning.ts`
- Modify: `packages/domain/src/day-planning.test.ts`

- [ ] **Step 1: Write failing classification tests**

Add tests covering exact logical-time boundaries, completed work, deterministic order, and a DST-short day:

```ts
import {
  buildCalmDay,
  buildTodayQueue,
  zonedDayWindow,
} from "./day-planning.ts";

it("classifies overdue, scheduled-today, unscheduled, and future tasks", () => {
  expect(
    buildTodayQueue({
      at: "2026-08-10T15:00:00.000Z",
      timeZone: "America/Chicago",
      tasks: [
        { id: "overdue-b", status: "open", plannedStart: "2026-08-10T13:00:00.000Z" },
        { id: "overdue-a", status: "open", plannedStart: "2026-08-09T18:00:00.000Z" },
        { id: "now", status: "open", plannedStart: "2026-08-10T15:00:00.000Z" },
        { id: "today", status: "open", plannedStart: "2026-08-11T04:59:59.999Z" },
        { id: "future", status: "open", plannedStart: "2026-08-11T05:00:00.000Z" },
        { id: "unscheduled-b", status: "open", plannedStart: null },
        { id: "unscheduled-a", status: "open", plannedStart: null },
        { id: "completed", status: "completed", plannedStart: "2026-08-10T14:00:00.000Z" },
        { id: "deleted", status: "open", plannedStart: "2026-08-10T14:00:00.000Z", deletedAt: "2026-08-10T14:30:00.000Z" },
      ],
    }),
  ).toEqual({
    overdueTaskIds: ["overdue-a", "overdue-b"],
    scheduledTodayTaskIds: ["now", "today"],
    unscheduledTaskIds: ["unscheduled-a", "unscheduled-b"],
    futureScheduledCount: 1,
  });
});

it("uses the owner's civil-day end across a DST transition", () => {
  expect(
    buildTodayQueue({
      at: "2026-03-08T07:30:00.000Z",
      timeZone: "America/Chicago",
      tasks: [
        { id: "last-today", status: "open", plannedStart: "2026-03-09T04:59:59.999Z" },
        { id: "first-tomorrow", status: "open", plannedStart: "2026-03-09T05:00:00.000Z" },
      ],
    }),
  ).toMatchObject({
    scheduledTodayTaskIds: ["last-today"],
    futureScheduledCount: 1,
  });
});
```

Add the matching fall-back case for `2026-11-01` in `America/Chicago`, where
the owner day ends at `2026-11-02T06:00:00.000Z`, so both 23-hour and 25-hour
civil days are covered.

- [ ] **Step 2: Run the focused domain test and confirm RED**

Run: `pnpm vitest run packages/domain/src/day-planning.test.ts`

Expected: FAIL because `buildTodayQueue` is not exported.

- [ ] **Step 3: Implement the pure classifier**

Add this public contract next to `CalmDayResult`, then implement it after `zonedDayWindow`:

```ts
export interface TodayQueueResult {
  readonly overdueTaskIds: readonly string[];
  readonly scheduledTodayTaskIds: readonly string[];
  readonly unscheduledTaskIds: readonly string[];
  readonly futureScheduledCount: number;
}

export const buildTodayQueue = (input: {
  readonly at: string;
  readonly timeZone: string;
  readonly tasks: readonly CalmTask[];
}): TodayQueueResult => {
  const now = Date.parse(input.at);
  const dayEnd = Date.parse(zonedDayWindow(input.at, input.timeZone).to);
  const open = input.tasks.filter(
    ({ status, deletedAt }) => status === "open" && deletedAt == null,
  );
  const scheduled = open
    .filter(
      (task): task is CalmTask & { readonly plannedStart: string } =>
        task.plannedStart != null,
    )
    .toSorted(
      (left, right) =>
        Date.parse(left.plannedStart) - Date.parse(right.plannedStart) ||
        left.id.localeCompare(right.id),
    );

  return {
    overdueTaskIds: scheduled
      .filter(({ plannedStart }) => Date.parse(plannedStart) < now)
      .map(({ id }) => id),
    scheduledTodayTaskIds: scheduled
      .filter(({ plannedStart }) => {
        const start = Date.parse(plannedStart);
        return start >= now && start < dayEnd;
      })
      .map(({ id }) => id),
    unscheduledTaskIds: open
      .filter(({ plannedStart }) => plannedStart == null)
      .map(({ id }) => id)
      .toSorted((left, right) => left.localeCompare(right)),
    futureScheduledCount: scheduled.filter(
      ({ plannedStart }) => Date.parse(plannedStart) >= dayEnd,
    ).length,
  };
};
```

Add `readonly deletedAt?: string | null` to `CalmTask`; existing server callers
may omit it, while the web classifier passes canonical Task values.

Do not modify `buildCalmDay`, `orderedTaskIds`, `nextTaskId`, or reminder behavior.

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `pnpm vitest run packages/domain/src/day-planning.test.ts`

Expected: all day-planning tests PASS.

- [ ] **Step 5: Run domain typecheck**

Run: `pnpm --filter @suite/domain typecheck`

Expected: PASS.

---

### Task 2: Persist the timezone input needed for cold offline classification

**Files:**

- Modify: `apps/web/src/local-store.ts`
- Modify: `apps/web/src/local-store.test.ts`

- [ ] **Step 1: Write failing IndexedDB metadata tests**

Use the existing fake IndexedDB setup in `local-store.test.ts`:

```ts
it("caches planning preferences without changing the IndexedDB schema", async () => {
  const store = new LocalStore({ indexedDb: indexedDB });
  const preferences = {
    workingDays: [1, 2, 3, 4, 5],
    workdayStart: "09:00",
    workdayEnd: "17:00",
    breakStart: "12:00",
    breakEnd: "12:30",
    timeZone: "America/Chicago",
  };

  expect(await store.loadPlanningPreferences()).toBeUndefined();
  await store.savePlanningPreferences(preferences);
  expect(await store.loadPlanningPreferences()).toEqual(preferences);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `pnpm vitest run apps/web/src/local-store.test.ts`

Expected: FAIL because the two preference methods do not exist.

- [ ] **Step 3: Add schema-validated metadata methods**

Import `planningPreferencesSchema` and `PlanningPreferences` from `@suite/contracts`, add `const planningPreferencesKey = "planning-preferences"`, and add:

```ts
async savePlanningPreferences(
  preferences: PlanningPreferences,
): Promise<void> {
  const database = await this.#open();
  const transaction = database.transaction(metadataStore, "readwrite");
  transaction
    .objectStore(metadataStore)
    .put(planningPreferencesSchema.parse(preferences), planningPreferencesKey);
  await transactionDone(transaction);
}

async loadPlanningPreferences(): Promise<PlanningPreferences | undefined> {
  const database = await this.#open();
  const transaction = database.transaction(metadataStore, "readonly");
  const value = await requestResult(
    transaction.objectStore(metadataStore).get(planningPreferencesKey),
  );
  await transactionDone(transaction);
  return value === undefined ? undefined : planningPreferencesSchema.parse(value);
}
```

Use the existing metadata object store; do not increment `databaseVersion` and do not put preferences into sync snapshots or diagnostics.

Keep these methods separate from `loadCachedTasks()` and the object returned by
`cachedTaskState()`. Task-sync publishes may spread task cache state into an
authenticated AppState; they must never spread cached preferences over the
server-authoritative value.

- [ ] **Step 4: Run local-store tests and web typecheck**

Run: `pnpm vitest run apps/web/src/local-store.test.ts && pnpm --filter @suite/web typecheck`

Expected: PASS.

---

### Task 3: Extract the shared Time Block form

**Files:**

- Create: `apps/web/src/time-block-form.tsx`
- Create: `apps/web/src/time-block-form.test.tsx`
- Modify: `apps/web/src/pages/TasksPage.tsx`

- [ ] **Step 1: Write server-rendered component tests**

Cover unscheduled, scheduled, and offline forms. Use a complete `Task` fixture from `apps/web/src/app.test.tsx` and one event-capable Baïkal calendar. Assert:

```ts
expect(unscheduledMarkup).toContain("Schedule");
expect(scheduledMarkup).toContain("Move calendar block");
expect(scheduledMarkup).toContain("Remove calendar block");
expect(offlineMarkup).toContain("Reconnect to change calendar blocks");
expect(offlineMarkup).toContain("disabled");
```

- [ ] **Step 2: Confirm the new test is RED**

Run: `pnpm vitest run apps/web/src/time-block-form.test.tsx`

Expected: FAIL because `TimeBlockForm` does not exist.

- [ ] **Step 3: Implement the shared form contract**

Create the component with this public interface:

```ts
import type { SyntheticEvent } from "react";
import type { BaikalStatusResponse, Task } from "@suite/contracts";

export interface TimeBlockFormProps {
  readonly task: Task;
  readonly calendars: BaikalStatusResponse["calendars"];
  readonly busy: boolean;
  readonly available: boolean;
  readonly onSubmit: (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
    task: Task,
  ) => Promise<void>;
  readonly onRemove: (task: Task) => Promise<void>;
}
```

Render Calendar, Start, and Minutes controls with the same names and limits currently used in `TasksPage`. Disable every calendar control when `busy || !available`; render the explicit reconnect message when unavailable; retain the manual-overlap hint. Use `Schedule` for an unscheduled task, `Move calendar block` for a scheduled task, and show `Remove calendar block` only when `plannedStart !== null`.

- [ ] **Step 4: Replace duplicated Tasks markup**

Import `TimeBlockForm` in `TasksPage.tsx` and replace the existing `<form className="time-block">` block with:

```tsx
<TimeBlockForm
  task={task}
  calendars={baikalCalendars}
  busy={busy}
  available={calendarActionsAvailable}
  onSubmit={onSubmitTimeBlock}
  onRemove={onRemoveTimeBlock}
/>
```

Add `calendarActionsAvailable: boolean` to `TasksPageProps` and supply it from
App. This extraction must not change mutation callback signatures.

- [ ] **Step 5: Run focused regressions**

Run: `pnpm vitest run apps/web/src/time-block-form.test.tsx apps/web/src/app.test.tsx && pnpm --filter @suite/web typecheck`

Expected: PASS.

---

### Task 4: Build the accessible Today queue component

**Files:**

- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/web/src/today-queue.tsx`
- Create: `apps/web/src/today-queue.test.tsx`

- [ ] **Step 1: Add the existing domain workspace dependency**

Add `"@suite/domain": "workspace:*"` to `apps/web/package.json` dependencies, then run:

`pnpm install --lockfile-only`

Expected: lockfile remains valid. Inspect the lockfile diff and preserve unrelated pre-existing changes.

- [ ] **Step 2: Write queue hierarchy tests**

Server-render `TodayQueue` with one task in each category and assert:

- `Overdue`, `Scheduled today`, and `Planning` are `h2` section headings.
- Future task titles never appear; `1 future task hidden` does.
- Without cached preferences, scheduled task titles still never appear and the
  unavailable-timezone count is explicit.
- Each repeated action has a task-specific accessible label such as `Complete “Quarterly report”`, `Start focus on “Quarterly report”`, and `Schedule “Inbox note”`.
- Offline markup retains Complete/Reopen but includes `Reconnect to start focus` and `Reconnect to change calendar blocks`.
- When all active arrays are empty, the component says `Nothing queued for today`.

- [ ] **Step 3: Implement typed hydration and capabilities**

Export these interfaces:

```ts
import type { SyntheticEvent } from "react";
import type {
  ActiveSession,
  BaikalStatusResponse,
  PlanningPreferences,
  Task,
} from "@suite/contracts";

export interface TodayQueueProps {
  readonly at: string;
  readonly preferences: PlanningPreferences | undefined;
  readonly tasks: readonly Task[];
  readonly activeSession: ActiveSession | null;
  readonly calendars: BaikalStatusResponse["calendars"];
  readonly busy: boolean;
  readonly calendarActionsAvailable: boolean;
  readonly focusActionsAvailable: boolean;
  readonly onStartFocus: (task: Task) => void;
  readonly onChangeTaskStatus: (
    task: Task,
    action: "complete" | "reopen",
  ) => Promise<boolean>;
  readonly onSubmitTimeBlock: (
    event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
    task: Task,
  ) => Promise<void>;
  readonly onRemoveTimeBlock: (task: Task) => Promise<void>;
  readonly onViewTasks: () => void;
}
```

When `preferences` exists, call `buildTodayQueue({ at, timeZone: preferences.timeZone, tasks })`, hydrate IDs through a `Map`, and render the three sections. When preferences are absent, render only open non-deleted tasks with `plannedStart == null` under Planning. Hide every scheduled task title and render: `N scheduled tasks hidden until the planning time zone is available.` Never fall back to the browser timezone or classify scheduled tasks as unscheduled.

Each semantic list row must include:

- Title, estimate when present, and explicit `Overdue`, local scheduled time, or `No time set` text.
- Complete/Reopen button with task-specific `aria-label`.
- Start focus button with task-specific `aria-label`; disable it while focus actions are unavailable, busy, or a nonterminal session exists for another task.
- `Focus running` text replaces—not accompanies—the Start button when `activeSession.taskId === task.id` and the session is nonterminal.
- A `<details>` disclosure labelled `Schedule “…”` or `Change schedule for “…”` containing `TimeBlockForm`.

Keep a local `recentlyCompletedIds` set. Change the callback result to
`Promise<boolean>`. Add an ID only when completion returns `true`; remove it
only when reopen returns `true`. Hydrate completed IDs from the latest `tasks`
prop and render them under a polite live region headed `Completed just now`.
Never treat a caught mutation error as success.

- [ ] **Step 4: Run focused queue tests**

Run: `pnpm vitest run apps/web/src/today-queue.test.tsx && pnpm --filter @suite/web typecheck`

Expected: PASS.

---

### Task 5: Make Focus row-driven without changing session authority

**Files:**

- Modify: `apps/web/src/focus-panel.tsx`
- Create: `apps/web/src/focus-panel.test.tsx`

- [ ] **Step 1: Add terminal and active-session rendering tests**

Assert that `showStartForm={false}` omits the all-task selector when no session exists, while running/controller/follower controls still render unchanged.

- [ ] **Step 2: Add a narrow presentation prop**

Extend `FocusPanelProps` with:

```ts
readonly showStartForm?: boolean;
```

Default it to `true`. In the terminal branch, keep recovery/offline status text but render `StartSession` only when `showStartForm` is true. Today will pass `false` because every actionable row supplies Start focus. Other callers retain current behavior.

Do not change command payloads, revisions, lease behavior, heartbeat behavior, takeover, or session/task completion independence.

- [ ] **Step 3: Run focus and app tests**

Run: `pnpm vitest run apps/web/src/focus-panel.test.tsx apps/web/src/app.test.tsx`

Expected: PASS.

---

### Task 6: Recompose Today around the daily loop

**Files:**

- Modify: `apps/web/src/pages/TodayPage.tsx`
- Modify: `apps/web/src/app.tsx`
- Modify: `apps/web/src/app.test.tsx`

- [ ] **Step 1: Write authenticated integration expectations**

Extend the authenticated App fixture with `planningPreferences` and `dayPlan` at a fixed timestamp. Include overdue, today, future, and unscheduled tasks. Assert:

```ts
expect(markup).toContain("<h1>Today</h1>");
expect(markup).toContain("Overdue");
expect(markup).toContain("Scheduled today");
expect(markup).toContain("Planning");
expect(markup).toContain("1 future task hidden");
expect(markup).not.toContain("Future task title");
expect(markup.indexOf("Capture a task")).toBeLessThan(
  markup.indexOf("Scheduled today"),
);
```

- [ ] **Step 2: Extend `TodayPageProps` with existing operations**

Add planning preferences, Baïkal calendars, status/calendar callbacks, and an `onViewTasks` callback. Pass queue row focus starts through the existing command shape:

```tsx
onStartFocus={(task) =>
  onFocusCommand({ command: "start", taskId: task.id })
}
```

Use separate `calendarActionsAvailable` and `focusActionsAvailable` props. Do
not derive either from `syncStatus === "online"`: task sync may legitimately be
`"syncing"` while server actions remain available.

- [ ] **Step 3: Reorder the page hierarchy**

Render in this order:

1. One `h1` labelled Today and human-written calm-state text.
2. A visible sync/capability message.
3. Capture form.
4. Active-session `FocusPanel` with `showStartForm={false}`.
5. `TodayQueue`.
6. Existing Week plan as secondary calendar context.

Replace raw `replaceAll("_", " ")` copy with a complete label map:

```ts
const calmStateLabel: Readonly<Record<DayPlanResponse["state"], string>> = {
  working: "Working",
  scheduled_break: "Scheduled break",
  unavailable: "Unavailable right now",
  finished_for_today: "Finished for today",
};
```

Maintain `logicalAt` in TodayPage, initialize it from
`dayPlan?.at ?? new Date().toISOString()`, update it every 60 seconds while
mounted, and reset it when a newly fetched `dayPlan.at` arrives. This makes
tasks cross into Overdue and rolls civil midnight without remounting. Use
`planningPreferences ?? dayPlan?.preferences` for timezone rules. Format task
times with `Intl.DateTimeFormat` and that exact IANA time zone, never the browser
default.

- [ ] **Step 4: Make task-status outcomes truthful**

Change `changeTaskStatus` and the matching Today/Tasks prop types to return
`Promise<boolean>`. Return `true` after the local IndexedDB status operation is
queued and published, including when remote sync is deferred. Return `false`
after `queueTaskStatus` or local publication fails. Existing callers may ignore
the boolean; Today uses it for Completed just now.

```ts
const changeTaskStatus = async (
  task: Task,
  action: "complete" | "reopen",
): Promise<boolean> => {
  if (state.kind !== "authenticated" && state.kind !== "offline") return false;
  setBusy(true);
  setFormError(null);
  try {
    await localStore.queueTaskStatus(task.id, action === "complete");
    await syncAfterLocalMutation();
    return true;
  } catch (error: unknown) {
    handleTaskError(error);
    return false;
  } finally {
    setBusy(false);
  }
};
```

- [ ] **Step 5: Wire callbacks and explicit server capabilities from App**

Pass `changeTaskStatus`, `submitTimeBlock`, `removeTimeBlock`, Baïkal calendars, and `navigate("tasks")` into Today. Preserve all existing command implementations; this task composes them and does not introduce new mutation APIs.

Track `networkOnline` from both browser `online` and `offline` events. Derive:

```ts
const calendarActionsAvailable =
  state.kind === "authenticated" && networkOnline;
const focusActionsAvailable =
  calendarActionsAvailable && state.client !== undefined;
```

Initialize `networkOnline` with
`typeof navigator === "undefined" ? true : navigator.onLine`. Register and
clean up both event listeners:

```ts
useEffect(() => {
  const markOnline = (): void => setNetworkOnline(true);
  const markOffline = (): void => setNetworkOnline(false);
  window.addEventListener("online", markOnline);
  window.addEventListener("offline", markOffline);
  return () => {
    window.removeEventListener("online", markOnline);
    window.removeEventListener("offline", markOffline);
  };
}, []);
```

Pass `calendarActionsAvailable` to both Today and Tasks and
`focusActionsAvailable` to Today/FocusPanel. `syncStatus: "syncing"` must not
disable either capability; an offline event must disable both immediately.

- [ ] **Step 6: Refresh IndexedDB after direct Time Block writes**

After successful schedule/move/remove, fetch the planner and day plan and run a
sync round before claiming success. Merge the returned local task cache into
state so the new `plannedStart` survives a cold offline start. Add an App test
whose mocked direct write changes `plannedStart`, then assert the synchronized
cache exposes that value after reload.

- [ ] **Step 7: Run authenticated integration tests**

Run: `pnpm vitest run apps/web/src/app.test.tsx apps/web/src/today-queue.test.tsx && pnpm --filter @suite/web typecheck`

Expected: PASS.

---

### Task 7: Preserve the Today workflow on a cold offline start

**Files:**

- Modify: `apps/web/src/app.tsx`
- Modify: `apps/web/src/app.test.tsx`

- [ ] **Step 1: Write the cold-offline contract test**

Extend the offline fixture with cached planning preferences and planned tasks. Assert that the rendered view contains:

- `Today`, `Overdue`, and `Planning`.
- `Offline. Tasks can be captured, completed, and reopened.`
- The capture form and task-specific Complete controls.
- Disabled, explanatory calendar and focus controls.
- Pending conflict count and redacted diagnostics export.
- No `Limited workspace` auth-card heading.

- [ ] **Step 2: Include cached preferences in offline state**

Extend the offline AppState member:

```ts
readonly planningPreferences?: PlanningPreferences;
```

Do **not** extend `cachedTaskState()` with preferences. During cold-offline
bootstrap, load `cachedTaskState()`, `localStore.loadPlanningPreferences()`, and
`localStore.clientIdentity()` separately, then construct Offline AppState. This
prevents `publishLocalState()` and `synchronize()` spreads from replacing the
authenticated server value with a stale or absent cache.

After `getPlanningPreferences()` succeeds in `loadAuthenticated`, call:

```ts
try {
  await localStore.savePlanningPreferences(planningPreferences);
} catch {
  setFormError(
    "Planning preferences are current, but they could not be cached for offline use.",
  );
}
```

The cache write may fail without preventing authenticated operation. Keep the
message content-safe and do not replace current server data with an older cache.

After `savePlanningPreferences` successfully updates the server, also cache the
returned `saved` value. Add a regression test that a later task sync cannot
overwrite the authenticated preference value with an older IndexedDB value.

- [ ] **Step 3: Render offline Today as a workspace, not auth**

Remove `state.kind === "offline"` from the auth-card predicate. Add a workspace branch for offline state that renders Today with:

```tsx
<TodayPage
  dayPlan={undefined}
  planningPreferences={state.planningPreferences}
  tasks={state.tasks}
  activeSession={null}
  clientId={null}
  syncStatus="offline"
  planner={null}
  baikalCalendars={[]}
  calendarActionsAvailable={false}
  focusActionsAvailable={false}
  busy={busy}
  onFocusCommand={() => undefined}
  onSubmitTask={submitTask}
  onChangeTaskStatus={changeTaskStatus}
  onSubmitTimeBlock={submitTimeBlock}
  onRemoveTimeBlock={removeTimeBlock}
  onViewTasks={() => navigate("tasks")}
/>
```

Keep Sync now, conflict count, and Export redacted sync diagnostics available in a status region. Do not render fake calendar data, fake focus state, or enabled server-authoritative controls.

Allow cold-offline workspace startup when a durable client identity exists even
if both cached task arrays are empty. This lets an established owner capture the
first offline task. Do not use "at least one cached task" as the availability
gate.

- [ ] **Step 4: Run offline and local-store regressions**

Run: `pnpm vitest run apps/web/src/app.test.tsx apps/web/src/local-store.test.ts apps/web/src/today-queue.test.tsx`

Expected: PASS.

---

### Task 8: Add responsive, accessible visual treatment

**Files:**

- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/today-queue.test.tsx`

- [ ] **Step 1: Add semantic class names before styling**

Use `today-header`, `today-capabilities`, `today-layout`, `today-section`, `today-task-row`, `today-task-meta`, `today-task-actions`, `today-planning`, and `today-completed`. Do not use inline styles for the new surface.

- [ ] **Step 2: Implement responsive layout rules**

- Constrain Today to a readable content width.
- Keep the queue and Planning sections in one reading-order column at every
  width; defer a two-column variant until usage evidence justifies it.
- Stack schedule controls on smaller viewports.
- Ensure action controls wrap and every touch target is at least 44 by 44 CSS pixels.
- Use text plus tokens—not color alone—for overdue, offline, focus-active, and completed states.
- Preserve visible `:focus-visible` outlines and reduced-motion behavior.
- Improve important muted/hint text contrast instead of reusing `#484f58` for capability or error explanations.

- [ ] **Step 3: Add accessibility assertions**

Assert one page `h1`, section `h2` headings, task-specific action labels, a polite live region for completion/local-save status, and textual offline explanations. Avoid asserting CSS class names as behavior.

- [ ] **Step 4: Run web checks**

Run: `pnpm vitest run apps/web/src && pnpm --filter @suite/web typecheck && pnpm --filter @suite/web build`

Expected: PASS.

- [ ] **Step 5: Perform browser validation**

Use the repository's normal local deployment and validate at desktop, 768px, and 390px widths:

1. Capture appears immediately in Planning.
2. Start focus is row-scoped and unavailable offline.
3. Schedule/move/remove preserves the existing Time Block conflict behavior.
4. Complete removes a row and Reopen restores it.
5. Future task titles remain absent.
6. Keyboard traversal reaches every action in reading order.
7. At 200% zoom no controls overlap or become unreachable.
8. With the browser forced offline, capture/complete/reopen update IndexedDB and
   the outbox, while calendar/focus controls remain disabled.
9. After an online Time Block move, reload offline and confirm the task retains
   its new classification from the synchronized local snapshot.
10. An established browser with zero cached tasks can cold-start offline and
    capture its first local task.

Record screenshots and console/network failures in execution notes; do not commit generated screenshots.

---

### Task 9: Add the focused verification gate and finalize docs

**Files:**

- Modify: `package.json`
- Modify: `docs/ROADMAP.md`
- Modify: `docs/product/feature-prioritization.md`

- [ ] **Step 1: Add the focused test command**

Add:

```json
"test:phase13": "vitest run packages/domain/src/day-planning.test.ts apps/web/src/local-store.test.ts apps/web/src/time-block-form.test.tsx apps/web/src/focus-panel.test.tsx apps/web/src/today-queue.test.tsx apps/web/src/app.test.tsx"
```

- [ ] **Step 2: Confirm documentation matches implementation**

Update Phase 13 status only after evidence exists. Keep Phase 9, 11, and 12 production acceptance truthful; this feature does not waive the 1.0 soak or stable-promotion gates.

- [ ] **Step 3: Run the focused phase gate**

Run: `pnpm test:phase13`

Expected: PASS.

- [ ] **Step 4: Run the repository gate**

Run: `pnpm verify`

Expected: formatting, lint, typecheck, all tests, and all builds PASS.

- [ ] **Step 5: Inspect the final diff**

Run: `git diff --check && git status --short && git diff --stat`

Expected: no whitespace errors; only intended Phase 13 source, tests, lockfile dependency entry, and planning docs changed. Do not discard unrelated pre-existing changes.

---

## Acceptance Evidence

- Domain tests prove logical-time membership at exact `at`/day-end boundaries and across DST.
- Component tests prove hierarchy, future-task hiding, unique accessible action names, offline explanations, and empty states.
- App tests prove authenticated and cold-offline composition.
- Existing task sync, Time Block, Active Session, planner/reminder, and full repository tests remain green.
- Browser validation proves capture, scheduling, focus, completion/reopen, responsive reflow, keyboard flow, and visible offline failure boundaries.

## Review Checklist

- **Spec coverage:** Every agreed action and queue category maps to Tasks 1–8; non-goals require no schema migration or API expansion.
- **Authority:** SQLite remains Task authority, Baïkal remains Time Block authority, and the server remains Active Session authority.
- **Offline:** Only task capture/status enters the outbox. Planning preferences are cached input, not a new sync entity.
- **Compatibility:** Existing `DayPlanResponse`, automation catalog, task field versions, and calendar write contracts remain unchanged.
- **Scope control:** No priority/rank field, due date, recurrence, automatic scheduler, or full Tasks editor is introduced.
- **UX:** Today has one `h1`; Capture precedes the queue; calendar week context is secondary; future work stays hidden.
- **Verification:** Focused Phase 13 and full `pnpm verify` gates both pass before completion is claimed.

Optional commit checkpoints may be used only when the execution request explicitly authorizes commits; otherwise leave verified changes uncommitted.
