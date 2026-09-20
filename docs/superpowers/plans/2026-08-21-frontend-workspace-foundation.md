# Frontend Workspace Foundation Implementation Plan

> Historical proposal, reconciled September 20, 2026. Do not execute unchecked
> steps as a backlog. See [the code-by-code audit](../../product/legacy-plan-reconciliation.md)
> for implemented units and residual issues #74–#76, and [the current checkpoint](../../STATUS.md)
> for release evidence. Original proposed commands and checkbox states are retained
> as history; file-length targets and example signatures are not current gates.


> **For agentic workers:** Execute this plan task-by-task. Recommended path:
> dispatch a fresh subagent per task, review each result with `review-quality`,
> then continue. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the Suite UI system and ship a cohesive Inbox, Planner, and command bar without changing task, sync, or calendar authority.

**Architecture:** Keep `App` as the owner of authentication, local-first sync, loading, mutations, and API calls. Extract the shell and presentational components around explicit props/callbacks; pages must not call `api.ts` directly. Planner consumes the existing bounded `/api/planner` projection and existing time-block edit/remove callbacks.

**Tech Stack:** React 19, TypeScript, Vite, Tailwind CSS v4, shadcn/ui (new-york), Radix primitives, Lucide React, Vitest, Testing Library.

---

## Scope contract

### Included

- shadcn/Tailwind-v4-compatible semantic design tokens and generated UI primitives.
- App shell extraction with Inbox and Planner routes.
- Inbox: unscheduled, open, non-deleted tasks; existing capture, focus, completion, and scheduling actions.
- Planner: visual day, three-day, and week views of bounded planner data; existing time-block edit/remove only.
- `Mod+K` command bar for navigation and existing safe actions.
- Refactor shared task display/capture code without behavior changes.

### Explicitly excluded

- New server endpoints, calendar providers, scheduler logic, drag/drop, collision resolution, automatic scheduling, or recurring task behavior.
- Task rank/priority/order persistence. Existing deterministic queue order and subtask reorder remain unchanged.
- Quick-capture token parsing (`+project`, `#tag`, `@planned-time`, `!deadline-time`), task deadlines, and all habit persistence. These require a later contract/migration slice.
- Replacing the app’s custom navigation with a router library.

### Invariants

- A task keeps one active authoritative calendar time block at most.
- Calendar changes remain online-only and use existing conditional mutation paths.
- Pages remain explicit-prop components. Do not create a global mutable UI store.
- Existing deep links and all existing routes retain behavior.
- Do not delete legacy styles until every consumer has migrated.

## Planned files

| Path | Responsibility |
| --- | --- |
| `apps/web/components.json` | shadcn CLI configuration for this Vite workspace. |
| `apps/web/vite.config.ts`, `apps/web/tsconfig*.json` | `@/*` alias required by generated components. |
| `apps/web/src/styles/{tokens,base,layout,legacy}.css` | Semantic tokens, base styles, shell styles, transitional current selectors. |
| `apps/web/src/lib/utils.ts` | `cn()` class merger. |
| `apps/web/src/components/ui/*` | CLI-generated accessible primitives; only add primitives used in this slice. |
| `apps/web/src/app/routes.ts` | Route type, route parsing, navigation metadata. |
| `apps/web/src/components/shell/*` | Sidebar, top bar, application chrome. |
| `apps/web/src/components/tasks/*` | Shared capture and task row presentation. |
| `apps/web/src/components/calendar/*` | Pure range math, toolbar, filters, grid/view renderers. |
| `apps/web/src/components/command-bar/*` | Command registry, accessible dialog, trigger. |
| `apps/web/src/pages/{InboxPage,PlannerPage}.tsx` | New route compositions. |
| `apps/web/src/app.tsx` | Retain controller ownership; wire extracted parts and planner loader. |
| `apps/web/src/**/*.test.tsx`, `apps/web/src/**/*.test.ts` | Regression and new behavior coverage. |

## Task 1: Install and configure the UI foundation

**Files:**
- Modify: `apps/web/package.json`
- Modify: `apps/web/vite.config.ts`
- Modify: `apps/web/tsconfig.json`, `apps/web/tsconfig.app.json`
- Create: `apps/web/components.json`
- Create: `apps/web/src/lib/utils.ts`
- Modify: `apps/web/src/styles.css`
- Create: `apps/web/src/styles/tokens.css`, `apps/web/src/styles/base.css`, `apps/web/src/styles/layout.css`, `apps/web/src/styles/legacy.css`

- [ ] **Step 1: Add the failing alias import smoke test.**

```tsx
// apps/web/src/lib/utils.test.ts
import { describe, expect, it } from "vitest"
import { cn } from "@/lib/utils"

describe("cn", () => {
  it("merges conditional class names", () => {
    expect(cn("base", false, undefined, "active")).toBe("base active")
  })
})
```

- [ ] **Step 2: Run the test.**

Run: `pnpm test -- apps/web/src/lib/utils.test.ts`

Expected: FAIL because the `@` alias and `cn` module do not exist.

- [ ] **Step 3: Add supported dependencies and shadcn configuration.**

Run from repository root:

```bash
pnpm --filter @suite/web add shadcn class-variance-authority clsx tailwind-merge lucide-react tw-animate-css
pnpm --filter @suite/web add -D @types/node
```

Set Vite aliases and matching TypeScript aliases exactly:

```ts
resolve: {
  alias: { "@": path.resolve(__dirname, "./src") },
},
```

Create `components.json` with `style: "new-york"`, `rsc: false`, `tailwind.config: ""`, `tailwind.css: "src/styles.css"`, `cssVariables: true`, and aliases for `@/components`, `@/components/ui`, `@/lib`, and `@/hooks`. Add:

```ts
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

- [ ] **Step 4: Split CSS without visual behavior change.**

`styles.css` imports the new files in this order:

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "./styles/tokens.css";
@import "./styles/base.css";
@import "./styles/layout.css";
@import "./styles/legacy.css";
```

Move the existing `@theme`, body/reset/focus/reduced-motion styles, workspace layout, and remaining component selectors respectively. In `tokens.css`, preserve current color values but define shadcn semantic aliases using `@theme inline`, including `background`, `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `accent`, `destructive`, `border`, `input`, and `ring`. Keep the UI dark by defining values in `.dark` and applying `className="dark"` at the existing app root.

- [ ] **Step 5: Verify.**

Run: `pnpm test -- apps/web/src/lib/utils.test.ts && pnpm --filter @suite/web typecheck`

Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add apps/web
git commit -m "feat: add semantic UI foundation"
```

## Task 2: Generate and prove the minimum primitive set

**Files:**
- Create: `apps/web/src/components/ui/{button,card,input,textarea,label,badge,separator,dialog,command}.tsx`
- Create: `apps/web/src/components/ui/ui.test.tsx`

- [ ] **Step 1: Write primitive accessibility tests.**

```tsx
import { render, screen } from "@testing-library/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

it("renders disabled buttons with native semantics", () => {
  render(<Button disabled>Save</Button>)
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
})

it("associates labels with inputs", () => {
  render(<><label htmlFor="title">Title</label><Input id="title" /></>)
  expect(screen.getByLabelText("Title")).toBeVisible()
})
```

- [ ] **Step 2: Run the test.**

Run: `pnpm test -- apps/web/src/components/ui/ui.test.tsx`

Expected: FAIL because primitive modules do not exist.

- [ ] **Step 3: Generate primitives.**

Run from `apps/web`:

```bash
pnpm dlx shadcn@latest add button card input textarea label badge separator dialog command
```

Do not hand-copy old Tailwind-v3 components. Retain CLI output, replace any default light values through semantic tokens only, and use `lucide-react` instead of emoji for new controls.

- [ ] **Step 4: Verify.**

Run: `pnpm test -- apps/web/src/components/ui/ui.test.tsx && pnpm --filter @suite/web typecheck`

Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/components apps/web/package.json pnpm-lock.yaml
git commit -m "feat: add accessible UI primitives"
```

## Task 3: Extract routes and shell without route changes

**Files:**
- Create: `apps/web/src/app/routes.ts`
- Create: `apps/web/src/components/shell/{AppShell,SidebarNav,TopBar}.tsx`
- Modify: `apps/web/src/app.tsx`
- Modify: `apps/web/src/app.test.tsx`

- [ ] **Step 1: Add route parser tests.**

```ts
import { expect, it } from "vitest"
import { routeFromPath } from "@/app/routes"

it.each([["/today", "today"], ["/tasks", "tasks"], ["/unknown", "today"]] as const)(
  "maps %s to %s",
  (path, expected) => expect(routeFromPath(path)).toBe(expected),
)
```

- [ ] **Step 2: Run the test.**

Run: `pnpm test -- apps/web/src/app.test.tsx`

Expected: FAIL until the route module is introduced and the existing parser is moved.

- [ ] **Step 3: Move only static route metadata and shell markup.**

Create `WorkspaceRoute = "today" | "tasks" | "reuse" | "connections" | "settings"` and move `workspaceRoutes`, `routeFromPath`, and `history.pushState` navigation helper from `app.tsx`. `AppShell` receives `route`, `onNavigate`, sync state, error state, sign-out callback, command trigger slot, and children. It renders the existing sidebar/top-bar semantics exactly, including `aria-current="page"`. `App` remains the sole owner of loading and mutation functions.

- [ ] **Step 4: Verify current deep links.**

Run: `pnpm test -- apps/web/src/app.test.tsx && pnpm --filter @suite/web typecheck`

Expected: PASS; `/today`, `/tasks`, `/reuse`, `/connections`, and `/settings` render as before.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/app.tsx apps/web/src/app apps/web/src/components/shell apps/web/src/app.test.tsx
git commit -m "refactor: extract workspace shell"
```

## Task 4: Extract shared task presentation

**Files:**
- Create: `apps/web/src/components/tasks/{TaskCaptureForm,TaskListItem}.tsx`
- Modify: `apps/web/src/pages/TodayPage.tsx`
- Modify: `apps/web/src/today-queue.tsx`
- Create: `apps/web/src/components/tasks/TaskCaptureForm.test.tsx`
- Modify: `apps/web/src/today-queue.test.tsx`

- [ ] **Step 1: Write capture forwarding tests.**

```tsx
it("submits a non-empty title and clears the field", async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn().mockResolvedValue(undefined)
  render(<TaskCaptureForm onSubmit={onSubmit} busy={false} />)
  await user.type(screen.getByLabelText("New task"), "Plan release")
  await user.click(screen.getByRole("button", { name: "Add task" }))
  expect(onSubmit).toHaveBeenCalledWith("Plan release")
  expect(screen.getByLabelText("New task")).toHaveValue("")
})
```

- [ ] **Step 2: Run the capture and queue tests.**

Run: `pnpm test -- apps/web/src/components/tasks/TaskCaptureForm.test.tsx apps/web/src/today-queue.test.tsx`

Expected: FAIL because the extracted component does not exist.

- [ ] **Step 3: Extract presentational components.**

`TaskCaptureForm` receives `onSubmit(title: string): Promise<void> | void` and `busy`; it preserves native form submission, focus behavior, and errors. `TaskListItem` receives a task plus explicit status/focus/schedule callbacks and availability flags. Move JSX from `TodayPage` and `TodayQueue`, not any queue sorting or app mutations. Convert migrated buttons/cards to new primitives only where props preserve labels and disabled semantics.

- [ ] **Step 4: Verify current Today behavior.**

Run: `pnpm test -- apps/web/src/pages/TodayPage.test.tsx apps/web/src/today-queue.test.tsx apps/web/src/time-block-form.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/components/tasks apps/web/src/pages/TodayPage.tsx apps/web/src/today-queue.tsx
git commit -m "refactor: share task capture and rows"
```

## Task 5: Add Inbox as a derived task view

**Files:**
- Create: `apps/web/src/pages/InboxPage.tsx`
- Create: `apps/web/src/pages/InboxPage.test.tsx`
- Modify: `apps/web/src/app/routes.ts`, `apps/web/src/app.tsx`, `apps/web/src/app.test.tsx`

- [ ] **Step 1: Write Inbox inclusion tests.**

```tsx
it("shows only active open tasks without a planned start", () => {
  render(<InboxPage tasks={[openUnscheduled, openScheduled, completed, deleted]} {...callbacks} />)
  expect(screen.getByText(openUnscheduled.title)).toBeVisible()
  expect(screen.queryByText(openScheduled.title)).not.toBeInTheDocument()
  expect(screen.queryByText(completed.title)).not.toBeInTheDocument()
  expect(screen.queryByText(deleted.title)).not.toBeInTheDocument()
})
```

- [ ] **Step 2: Run the test.**

Run: `pnpm test -- apps/web/src/pages/InboxPage.test.tsx`

Expected: FAIL because the Inbox route and page do not exist.

- [ ] **Step 3: Add route and page.**

Extend `WorkspaceRoute` with `"inbox"`; add route metadata and `/inbox` parser support. `InboxPage` derives, rather than persists, its list with:

```ts
const inboxTasks = tasks.filter(
  (task) => task.status === "open" && task.deletedAt === null && task.plannedStart === null,
)
```

Compose `TaskCaptureForm` and `TaskListItem`; forward existing app callbacks for create, complete, focus, and schedule. Wire the page in `App` and add the deep-link assertion. Do not add an API endpoint or task field.

- [ ] **Step 4: Verify.**

Run: `pnpm test -- apps/web/src/pages/InboxPage.test.tsx apps/web/src/app.test.tsx && pnpm --filter @suite/web typecheck`

Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/app.tsx apps/web/src/app/routes.ts apps/web/src/pages/InboxPage.tsx apps/web/src/pages/InboxPage.test.tsx apps/web/src/app.test.tsx
git commit -m "feat: add derived task inbox"
```

## Task 6: Build pure calendar range and placement models

**Files:**
- Create: `apps/web/src/components/calendar/calendar-range.ts`
- Create: `apps/web/src/components/calendar/calendar-range.test.ts`

- [ ] **Step 1: Write range tests.**

```ts
it("builds a week beginning on Monday in the supplied timezone", () => {
  expect(buildCalendarRange("week", new Date("2026-08-19T12:00:00Z"), "Europe/London")).toEqual({
    from: "2026-08-17T00:00:00.000Z",
    to: "2026-08-24T00:00:00.000Z",
  })
})

it("uses a 72-hour range for three-day view", () => {
  const { from, to } = buildCalendarRange("3day", new Date("2026-08-19T12:00:00Z"), "UTC")
  expect(Date.parse(to) - Date.parse(from)).toBe(72 * 60 * 60 * 1000)
})
```

- [ ] **Step 2: Run the test.**

Run: `pnpm test -- apps/web/src/components/calendar/calendar-range.test.ts`

Expected: FAIL because calendar range functions do not exist.

- [ ] **Step 3: Implement timezone-safe pure functions.**

Export `CalendarView = "day" | "3day" | "week"`, `buildCalendarRange`, `shiftCalendarAnchor`, `calendarDays`, and `isEventInRange`. Use the app’s existing date/time formatting dependency or native `Intl`; do not parse display strings. `buildCalendarRange` must produce a window no larger than 31 days and use half-open `[from, to)` inclusion. Include all-day events by their calendar date and timed events by interval intersection.

- [ ] **Step 4: Verify DST, inclusion, and bounds.**

Run: `pnpm test -- apps/web/src/components/calendar/calendar-range.test.ts`

Expected: PASS, including a DST transition fixture and all-day event fixture.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/components/calendar/calendar-range.ts apps/web/src/components/calendar/calendar-range.test.ts
git commit -m "feat: add planner calendar range model"
```

## Task 7: Ship visual Planner day, three-day, and week views

**Files:**
- Create: `apps/web/src/components/calendar/{CalendarToolbar,CalendarFilters,CalendarGrid}.tsx`
- Create: `apps/web/src/pages/PlannerPage.tsx`, `apps/web/src/pages/PlannerPage.test.tsx`
- Modify: `apps/web/src/app/routes.ts`, `apps/web/src/app.tsx`, `apps/web/src/app.test.tsx`
- Modify: `apps/web/src/styles/legacy.css`

- [ ] **Step 1: Write Planner interaction tests.**

```tsx
it("changes from day to week and loads the corresponding bounded window", async () => {
  const user = userEvent.setup()
  const loadPlanner = vi.fn().mockResolvedValue(plannerFixture)
  render(<PlannerPage loadPlanner={loadPlanner} timeZone="UTC" {...props} />)
  await user.selectOptions(screen.getByLabelText("Calendar view"), "week")
  expect(loadPlanner).toHaveBeenCalledWith(expect.objectContaining({ view: "week" }))
})

it("renders projected events and planned tasks without mutation controls", () => {
  render(<PlannerPage planner={plannerFixture} {...props} />)
  expect(screen.getByText("Provider event")).toBeVisible()
  expect(screen.getByText("Planned Suite task")).toBeVisible()
  expect(screen.queryByLabelText(/drag/i)).not.toBeInTheDocument()
})
```

- [ ] **Step 2: Run the test.**

Run: `pnpm test -- apps/web/src/pages/PlannerPage.test.tsx`

Expected: FAIL because no Planner page exists.

- [ ] **Step 3: Add the visual-only page.**

`PlannerPage` owns local `view` and anchor-date state. It calls an injected `loadPlanner({ from, to })` whenever the pure range changes; `App` implements that callback using existing `getPlanner`. Render toolbar controls labelled **Today**, **Previous period**, **Next period**, and **Calendar view**. Render events and tasks in a CSS-grid calendar with textual interval labels; expose provider freshness and calendar visibility filters. A task’s existing schedule edit/remove callback opens the current form/action path; provider events have no edit action. No pointer drag handlers are allowed.

- [ ] **Step 4: Wire `/planner` and preserve Today.**

Add the Planner route and sidebar entry. Keep Today’s week context intact. Add an accessible **Open planner** link/button from Today that calls the extracted route navigation callback.

- [ ] **Step 5: Verify.**

Run: `pnpm test -- apps/web/src/pages/PlannerPage.test.tsx apps/web/src/pages/TodayPage.test.tsx apps/web/src/app.test.tsx apps/web/src/time-block-form.test.tsx && pnpm --filter @suite/web typecheck`

Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/components/calendar apps/web/src/pages/PlannerPage.tsx apps/web/src/app.tsx apps/web/src/app/routes.ts apps/web/src/styles/legacy.css apps/web/src/app.test.tsx
git commit -m "feat: add visual planner views"
```

## Task 8: Add accessible command bar over existing actions

**Files:**
- Create: `apps/web/src/components/command-bar/{command-types,command-registry,CommandBar,CommandBarTrigger}.tsx`
- Create: `apps/web/src/components/command-bar/CommandBar.test.tsx`
- Modify: `apps/web/src/components/shell/TopBar.tsx`, `apps/web/src/app.tsx`

- [ ] **Step 1: Write keyboard behavior tests.**

```tsx
it("opens with Mod+K and navigates to Inbox", async () => {
  const user = userEvent.setup()
  const onNavigate = vi.fn()
  render(<CommandBar {...commandProps} onNavigate={onNavigate} />)
  await user.keyboard("{Meta>}k{/Meta}")
  await user.type(screen.getByPlaceholderText("Search commands"), "inbox")
  await user.keyboard("{Enter}")
  expect(onNavigate).toHaveBeenCalledWith("inbox")
})

it("does not execute an unavailable command", async () => {
  render(<CommandBar {...offlineCommandProps} />)
  expect(screen.getByText("Sync now").closest("[aria-disabled]"))
    .toHaveAttribute("aria-disabled", "true")
})
```

- [ ] **Step 2: Run the test.**

Run: `pnpm test -- apps/web/src/components/command-bar/CommandBar.test.tsx`

Expected: FAIL because command bar modules do not exist.

- [ ] **Step 3: Implement declarative commands.**

Define a narrow command context with callbacks, not `AppState` mutation access. Register: Navigate Today/Inbox/Planner/Tasks/Settings; Create task (focuses the current route’s capture trigger); Sync now; Start focus on next eligible task; Sign out. Each command declares `id`, `label`, `keywords`, `group`, `enabled`, and `run`. Use shadcn `Command` within `Dialog`, implement `Mod+K`/`Ctrl+K`, arrows, Enter, and Escape, and return focus to the trigger on close. Offline/unauthorized actions must render disabled rather than fail silently.

- [ ] **Step 4: Add top-bar trigger and wire callbacks.**

TopBar receives `commandTrigger` slot. `App` maps already-existing handlers into the narrow command context. The command bar must never import `api.ts`, `local-store.ts`, or `sync-engine.ts`.

- [ ] **Step 5: Verify.**

Run: `pnpm test -- apps/web/src/components/command-bar/CommandBar.test.tsx apps/web/src/app.test.tsx && pnpm --filter @suite/web typecheck`

Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/components/command-bar apps/web/src/components/shell/TopBar.tsx apps/web/src/app.tsx
git commit -m "feat: add workspace command bar"
```

## Task 9: Migrate high-traffic UI to semantic primitives and retire compatibility CSS

**Files:**
- Modify: `apps/web/src/pages/{TodayPage,TasksPage,InboxPage,PlannerPage}.tsx`
- Modify: `apps/web/src/components/{shell,tasks,calendar,command-bar}/**/*.tsx`
- Modify: `apps/web/src/styles/{legacy,tokens}.css`
- Modify: affected web tests

- [ ] **Step 1: Identify legacy selector consumers.**

Run: `rg "btn-primary|btn-ghost|card|page-header|filter-bar" apps/web/src --glob '*.{ts,tsx,css}'`

Expected: a finite list of remaining consumers to migrate; record it in the PR description.

- [ ] **Step 2: Replace component-level classes one surface at a time.**

Migrate Shell, Today/Inbox rows, Planner toolbar, and Tasks controls to `Button`, `Card`, `Input`, `Label`, `Badge`, and `Separator`. Do not mix semantic variants with ad-hoc color utility classes. Preserve names, `aria-*` attributes, submit behavior, disabled conditions, and task-specific labels in every test fixture.

- [ ] **Step 3: Delete only unused selectors.**

After each migration, re-run the selector search. Delete a legacy selector only when it has no TypeScript/TSX/CSS consumer. Retain page-grid selectors that express layout rather than UI primitive styling.

- [ ] **Step 4: Run focused and full web checks.**

Run: `pnpm test -- apps/web/src && pnpm --filter @suite/web typecheck && pnpm lint`

Expected: PASS.

- [ ] **Step 5: Manual browser verification.**

Verify at desktop and ≤640px: sidebar route navigation, focused control ring, task capture, Inbox filtering, Planner view switching/date navigation/filter toggles, schedule edit/remove, command-bar open/search/close, and reduced-motion behavior.

- [ ] **Step 6: Commit.**

```bash
git add apps/web
git commit -m "refactor: migrate workspace to semantic UI"
```

## Completion gate

- [ ] Existing routes and deep links work.
- [ ] shadcn primitives use Suite-owned dark semantic tokens; no default shadcn palette leaks.
- [ ] Inbox is derived correctly and does not add a persistence model.
- [ ] Planner renders day, 3-day, and week views from the existing bounded projection; it does not create/move events by drag/drop.
- [ ] Command bar is keyboard-accessible and only invokes existing app callbacks.
- [ ] `pnpm test -- apps/web/src`, `pnpm --filter @suite/web typecheck`, and repository lint pass.

## Follow-on vertical slices

1. **Structured capture and task deadline:** pure parser for `+project`, `#tag`, `@planned-time`, `!deadline-time`; explicit unknown-reference behavior; add `deadlineAt` contract/persistence/sync/automation support.
2. **Habits:** separate `Habit` plus immutable completion ledger, cadence/time-zone/missed-day rules, streak/metric derivation, sync and automation contracts, then a Habits page.
3. **Planning interaction:** only after visual planner acceptance—drag/drop proposal UX, conflict display, conditional confirmation, and no automatic scheduling unless separately approved.
