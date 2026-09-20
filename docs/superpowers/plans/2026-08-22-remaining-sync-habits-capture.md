# Remaining Sync, Habits, and Capture Implementation Plan

> **For agentic workers:** Execute this plan task-by-task. Recommended path:
> dispatch a fresh subagent per task, review each result with `review-quality`,
> then continue. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete safe sync-v2 mutations, habit automation/UI, and resolved structured capture.

**Architecture:** Keep `plannedStart` snapshot-only because time-block placement is calendar-authoritative. Treat a deadline as one logical sync field even though SQLite stores a date or instant in separate columns. Habits are independent owner-scoped resources; their immutable occurrence facts derive metrics.

**Tech Stack:** TypeScript, Zod, Node SQLite, React 19, IndexedDB, Vitest, shadcn/ui.

---

## Current committed baseline

- Commit `feat: add workspace and habit foundations` includes UI shell/Inbox/Planner/command bar, structured parser, deadlines, habits persistence/API, and sync v2 header gate.
- Migrations: `0015_task_deadlines`, `0016_habits`, `0017_sync_v2_deadline_epoch_reset`.
- `pnpm test` and `pnpm typecheck` passed before commit (168 tests).
- Sync v2 has epoch reset and header gate only. It does **not** yet apply deadline/habit queued operations or migrate IndexedDB.

## Development checkpoint — 2026-09-19

The first resumed increment restores the repository gate and completes deadline
sync plus safe cursor/cache reset behavior. The original plan is preserved below;
unchecked habit and structured-capture work is still outstanding.

Implemented and verified in this worktree:

- Restored formatting and lint checks, including a root TypeScript project for
  the Vitest configuration and correct async callback handling.
- Invalid, expired, and out-of-range cursors are checked before queued mutations.
  Incremental responses still include writes made by the same round.
- IndexedDB upgrades from version 1 to 2 preserve identity, credentials, sequence,
  immutable outbox records, and unresolved conflicts. A full snapshot precedes
  replay, and incomplete/invalid/failed snapshots leave existing data intact.
- Date-only, timestamp, and cleared deadlines share one field version. HTTP edits
  and queued edits advance the same version; stale deadline retries remain
  conflicts. Calendar-authoritative planned starts are still excluded from sync.
- Additive migration `0018_missing_deadline_field_versions` repairs missing
  versions without rewriting task contents, existing field versions, or the sync
  epoch. New HTTP/sync/template tasks initialize a deadline field version.
- Tasks now has a deadline editor with explicit date-only and UTC timestamp
  inputs. Browser edits use the durable task outbox.

Verification: frozen-lockfile installation with pnpm 11.15.1; `pnpm verify`
passed formatting, lint, typechecks, 177 tests across 53 files, and all four
builds. `git diff --check` passed. A disposable server-backed browser with a
separate real Baïkal container verified owner setup/login, calendar connection,
task capture, date deadline persistence, offline timestamp editing, cold offline
reload, reconnect/replay without duplication, clearing a deadline across reload,
and 390-pixel layout without horizontal overflow. The forced
offline request failure is expected; this is local qualification, not production
acceptance or a soak. Browser artifacts are under `output/playwright/`.

Remaining: habit sync operations and projections, explicit protocol-version
response fields, habit caches/UI/automation, resolved structured capture, and
verification of those remaining flows. Production and remote branches were not
changed by this increment.

### Task 1: Finish v2 contract and protocol surface

**Files:**
- Modify: `packages/contracts/src/index.ts:829-944`
- Modify: `apps/server/src/routes/sync.ts:153-631`
- Test: `packages/contracts/src/index.test.ts`
- Test: `apps/server/src/phase2.test.ts`

- [x] Add `deadline` to `coreTaskFieldSchema` and `taskFieldVersionsSchema`.
- [x] Permit only `deadline` (`TaskDeadline | null`) in sync task create/patch fields; do not add `plannedStart` to an operation schema.
- [x] Add v2 habit operations: create, patch, archive, restore, and immutable occurrence complete. Occurrence completion uses its operation UUID as the candidate occurrence identity.
- [x] Add `habit` and `habit_occurrence` sync snapshot variants.
- [x] Add protocol version `2` to registration/round/snapshot response schemas and assert missing header returns 426 before parsing/executing operations.
- [x] Test date, instant, and null deadlines; reject sync planned starts; reject empty habit patch and any occurrence edit/delete command.
- [x] Run: `pnpm test -- packages/contracts/src/index.test.ts apps/server/src/phase2.test.ts`
- [x] Commit: `feat: define sync v2 operations`

### Task 2: Implement deadline and habit sync persistence

**Files:**
- Modify: `packages/persistence/src/index.ts:4550-4830,4935-5100`
- Modify: `packages/persistence/src/index.test.ts`
- Test: `apps/server/src/phase2.test.ts`

- [x] Map logical deadline writes atomically: date -> `deadline_date`, instant -> `deadline_at`, null -> both null.
- [x] Advance `deadline` field versions for online PATCH and sync operations. Keep `plannedStart` excluded from sync operations.
- [x] Add transactional habit sync methods: create, patch, archive, restore, occurrence complete.
- [x] Append a sync change and operation outcome in the same transaction as every successful mutation.
- [x] For duplicate habit-period completion, return the existing canonical occurrence without another change row.
- [x] Enforce owner scope before every habit/occurrence mutation.
- [x] Test deadline/title disjoint merge, deadline conflict, habit stale revision, archive/restore, duplicate occurrence convergence, and cross-owner rejection.
- [x] Run: `pnpm test -- packages/persistence/src/index.test.ts apps/server/src/phase2.test.ts`
- [x] Commit: `feat: sync deadlines and habits`

### Task 3: Finish server snapshot/round ordering

**Files:**
- Modify: `apps/server/src/routes/sync.ts:200-631`
- Test: `apps/server/src/phase2.test.ts`
- Test: `apps/server/src/phase5.test.ts`
- Test: `apps/server/src/phase6.test.ts`

- [x] Validate cursor epoch/range before executing any queued operation; return reset before side effects.
- [x] Include deadline snapshots, habits, and occurrences in full and incremental projections.
- [x] Page changes from the validated original cursor after applying the round, so response includes local changes.
- [x] Return canonical occurrence ID for duplicate completions.
- [x] Test invalid cursor leaves task/outcome untouched and snapshot + replay applies an operation once.
- [x] Run: `pnpm test -- apps/server/src/phase2.test.ts apps/server/src/phase5.test.ts apps/server/src/phase6.test.ts`
- [x] Commit: `fix: make sync resets side-effect free`

### Task 4: Migrate IndexedDB and replay safely

**Files:**
- Modify: `apps/web/src/local-store.ts`
- Modify: `apps/web/src/sync-engine.ts`
- Modify: `apps/web/src/api.ts`
- Test: `apps/web/src/local-store.test.ts`
- Test: `apps/web/src/sync-engine.test.ts`

- [x] Bump IndexedDB schema; preserve identity, credentials, client sequence, outbox, and conflicts.
- [x] Persist `syncProtocolVersion: 2` and `resetRequired` metadata.
- [x] On upgrade/reset, fetch a complete snapshot before sending an outbox round.
- [x] Replace only canonical caches in one transaction; preserve queued/sending operations ordered by client sequence and retain conflicts/rejections.
- [x] Add habit/occurrence entity caches and queue helpers.
- [x] Do not optimistically create an occurrence cache row. Show it only after canonical server response.
- [x] Test restart persistence, snapshot failure atomicity, retained outbox IDs/hashes, deadline conflict visibility, and canonical duplicate occurrence convergence.
- [x] Run: `pnpm test -- apps/web/src/local-store.test.ts apps/web/src/sync-engine.test.ts`
- [x] Commit: `feat: replay sync v2 cache safely`

### Task 5: Resolve structured capture atomically

**Files:**
- Modify: `packages/domain/src/structured-capture.ts`
- Modify: `apps/server/src/routes/tasks.ts`
- Modify: `packages/persistence/src/index.ts`
- Modify: `apps/web/src/components/tasks/TaskCaptureForm.tsx`
- Test: `packages/domain/src/structured-capture.test.ts`
- Test: `apps/server/src/server.test.ts`

- [ ] Define quoted/escaped token behavior; reject unknown, archived, and ambiguous project names; reject unknown tags.
- [ ] Resolve project/tag names and parsed times before task insert; create task, assignments, planned start, and deadline in one transaction.
- [ ] Reuse parser at web, HTTP, quick-add, and automation boundaries.
- [ ] Do not implicitly create projects/tags.
- [ ] Test parser ambiguity, natural date/instant deadline conversion, and no partial task after failed reference resolution.
- [ ] Run: `pnpm test -- packages/domain/src/structured-capture.test.ts apps/server/src/server.test.ts`
- [ ] Commit: `feat: resolve structured task capture`

### Task 6: Finish habits UI and automation

**Files:**
- Create: `apps/web/src/pages/HabitsPage.tsx`
- Modify: `apps/web/src/app/routes.ts`
- Modify: `apps/web/src/app.tsx`
- Modify: `apps/web/src/api.ts`
- Modify: `apps/server/src/routes/automation.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `apps/web/src/pages/HabitsPage.test.tsx`

- [ ] Add Habits navigation, create form, archive control, completion action, and derived current/longest streak display.
- [ ] Use server canonical occurrences and owner timezone; do not mutate a streak counter.
- [ ] Add `habits:read`/`habits:write` automation scopes and preview/confirm operations.
- [ ] Freeze resolved habit IDs and revisions in previews; revalidate at confirmation.
- [ ] Test accessible controls, offline disabled state, replayed completion, and preview-confirm idempotency.
- [ ] Run: `pnpm test -- apps/web/src/pages/HabitsPage.test.tsx apps/server/src/server.test.ts`
- [ ] Commit: `feat: add habits workspace`

### Task 7: Final verification and review

**Files:**
- Inspect: all changed files

- [ ] Run `pnpm test`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `rtk git diff --check`.
- [ ] Exercise app flows: command capture, Inbox, Planner, deadline edit, offline reset/replay, habit completion, duplicate completion.
- [ ] Review for sync epoch/data-loss regressions and mobile navigation/accessibility.
- [ ] Commit any final focused corrections, then push.

## Self-review

- `plannedStart` never enters a sync mutation.
- Deadline is one logical field/version.
- Every habit completion is immutable and period-deduplicated.
- A reset occurs before mutation; replay preserves operation IDs, hashes, and client sequence.
- No project/tag implicit creation occurs.

### Habit sync checkpoint — 2026-09-19

Habit create, title edit, archive/restore, and immutable completion now share a
transactional owner-scoped store across HTTP and sync. Schedule identity stays
fixed after creation so edits cannot reinterpret historical completion facts.
Repeated completion converges on the original occurrence ID without a new change.
Outcomes survive restart and reject changed payloads under the same key. Additive
migration 0019 stores those outcomes; all v2 responses explicitly carry version 2.
Client habit queues preserve their operation IDs across restart/reset and cache
only canonical occurrences. The complete repository gate passed: 180 tests in 54
files plus format, lint, typechecks, and four builds. UI and automation remain next.
