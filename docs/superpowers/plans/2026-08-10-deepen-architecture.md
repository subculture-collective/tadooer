# Deepen Architecture — Modularity Refactor

> Historical proposal, reconciled September 20, 2026. Do not execute unchecked
> steps as a backlog. See [the code-by-code audit](../../product/legacy-plan-reconciliation.md)
> for implemented units and residual issues #74–#76, and [the current checkpoint](../../STATUS.md)
> for release evidence. Original proposed commands and checkbox states are retained
> as history; file-length targets and example signatures are not current gates.


> **For agentic workers:** Execute this plan phase-by-phase. Each phase's tasks are independent and can be dispatched in parallel. Review each phase's result before continuing. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform 6 monolithic modules (server.ts 6884L, app.tsx 2560L, persistence/index.ts 6477L, contracts/index.ts 1872L, web/api.ts 951L, web/local-store.ts 797L) into focused bounded-context modules, and establish a living domain glossary.

**Architecture:** Extract route handlers, page components, store classes, and HTTP plumbing by bounded context. Establish persistence interfaces as seams between callers and stores. Unify automation client generation from the existing catalog. The domain glossary (CONTEXT.md) grounds all naming.

**Tech Stack:** TypeScript 5.9, Node 24, React 19, Zod 4, node:sqlite, Vitest 4

---

## Dependency Graph

```
Phase 1 (parallel, foundational)
  ├── CONTEXT.md glossary
  ├── HTTP plumbing extraction
  └── Persistence store interfaces
       │
Phase 2 (sequential after Phase 1)
  ├── Split SuiteDatabase into bounded-context stores
  └── Unify automation client generation
       │
Phase 3 (sequential after Phase 2)
  └── Break server.ts into bounded-context route modules
       │
Phase 4 (sequential after Phase 3)
  └── Break app.tsx into page components
```

Each phase must pass `pnpm typecheck && pnpm lint && pnpm test` before the next phase begins.

---

## Phase 1: Foundation

Three parallel workstreams. Each touches a different package/app.

### Task 1.1: Create CONTEXT.md domain glossary

**Files:**
- Create: `CONTEXT.md`

**Goal:** Extract the canonical domain glossary from ADRs and code into a single file. Every deepening candidate uses these terms.

- [ ] **Step 1: Extract domain terms from ADRs**

Read `docs/adr/0001` through `docs/adr/0016` and extract all defined domain concepts. Use the glossary already synthesized in the architecture review:

| Term | Definition |
|---|---|
| **Owner** | The single human account that deploys and uses the suite. All records scoped to a stable owner UUID. |
| **Task** | Suite-owned mutable resource with UUID identity, positive integer revision, per-field versions, soft-delete/recover lifecycle. |
| **Project** | Owner-scoped UUID record with title, revision, optional archive. A task belongs to zero or one project. |
| **Tag** | Owner-scoped UUID record with display name, case-folded uniqueness key, revision, optional archive. Max 25 per task. |
| **Subtask** | One-level checklist record. Not recursive; cannot own projects, calendar blocks, or focus sessions. |
| **Choice Pool** | Owner-scoped record containing Pool Items with append-only selection/completion history and one of four policies. |
| **Pool Item** | Candidate inside a Choice Pool. Eligibility evaluated at an explicit logical timestamp. |
| **Planning Placeholder** | Attached to one task and one pool. Resolution creates ordered subtasks. |
| **Task Template** | Inert first-class record (title, notes, estimate, tags, suggested project, subtask blueprints). Never appears in active-task queries. |
| **Template Set** | Ordered collection of active Task Templates. Not a Project Template. |
| **Template Instantiation** | Atomic SQLite transaction creating independent tasks from a template with provenance. |
| **Calendar Provider** | Qualified source of calendar data (Baïkal, Google). Each calendar has exactly one authoritative provider. |
| **Calendar Projection** | Bounded, cached read of calendar events in Suite SQLite. Never duplicates authoritative calendar resources. |
| **Time Block** | Suite-created VEVENT linking a task to a calendar interval. At most one active block per task. |
| **Active Session** | Server-authoritative focus/break session. At most one nonterminal per owner. 90-second lease, 30-second heartbeat, 24-hour hard expiry. |
| **Controller / Follower** | One registered client controls the active session; others are read-only with explicit takeover. |
| **Client** | Durable browser installation with owner-scoped UUID and one-time 256-bit credential. |
| **Automation Credential** | Opaque bearer token `suite_at_<UUID>.<secret>`. Owner-bound, scoped, expiring, revocable. |
| **Preview / Confirmation** | Two-phase mutation: preview has no side effects; confirmation executes only if preview is unexpired and revisions match. |
| **Idempotency Key** | 8–128 URL-safe chars for retriable creates. Same key + hash replays original outcome. |
| **Revision / ETag** | Positive integer revision. Mutations require `If-Match`. |
| **ntfy** | Write-only delivery adapter for notifications. Suite owns reminder intent and delivery history. |
| **Capability URL** | Opaque 256-bit secret for read-only iCalendar publication. |
| **DAV Resource** | Calendar event stored authoritatively in Baïkal. Qualified by Suite provider UUID + calendar UUID + provider-native identifier. |
| **Calm Day** | Deterministic evaluation of working state (working/break/unavailable/finished) based on working hours, breaks, calendar busy time. |
| **Sync Round** | Ordered change stream with persistent epoch + positive sequence. Field-level merge with per-field versions. |
| **Local Store** | IndexedDB cache of canonical task/project/tag/subtask/template/pool snapshots with outbox and conflict tracking. |
| **Sync Engine** | Foreground sync coordinator: registers client, loads outbox, sends round, applies response, handles cursor reset. |
| **Automation Catalog** | Declarative catalog in `@suite/contracts` defining operation/resource identifiers, scopes, HTTP mappings, MCP names, Zod schemas. |
| **Migration** | Versioned SQL schema change in `packages/persistence`. 14 migrations (0001–0014) applied atomically. |

- [ ] **Step 2: Add bounded context map**

```markdown
## Bounded Contexts

| Context | Owns | Packages |
|---|---|---|
| Owner & Auth | Owner identity, sessions, password hashing, CSRF | `packages/persistence`, `apps/server/auth.ts` |
| Task | Task CRUD, projects, tags, subtasks, status lifecycle, soft-delete | `packages/domain`, `packages/persistence`, `apps/server`, `apps/web` |
| Calendar | Provider connections, event projections, time blocks, planner | `packages/caldav`, `packages/google-calendar`, `apps/server/connector.ts` |
| Planning | Calm day evaluation, working hours, breaks, reminder suppression | `packages/domain/day-planning.ts` |
| Active Session | Focus/break state machine, controller/follower, lease expiry | `packages/domain/active-session.ts` |
| Sync | Client registration, change stream, per-field versions, outbox, conflicts | `apps/web/local-store.ts`, `apps/web/sync-engine.ts` |
| Templates | Template CRUD, template sets, instantiation with provenance | `packages/persistence` |
| Choice Pools | Pool/item CRUD, eligibility, suggestions, placeholder resolution | `packages/domain/choice-pool.ts`, `packages/persistence` |
| Automation | Tokens, preview/confirm, audit, MCP/CLI/HTTP surfaces | `packages/contracts`, `apps/server`, `apps/mcp-stdio`, `apps/quick-add` |
| Notifications | ntfy delivery, reminder ledger, occurrence evaluation | `apps/server/notifications.ts`, `packages/domain/notifications.ts` |
| Import/Export | ICS import parsing, iCalendar publication feeds | `packages/import-export` |
```

- [ ] **Step 3: Add architectural principles section**

```markdown
## Architectural Principles

1. **One authority per resource.** Every calendar has exactly one authoritative provider. Suite SQLite owns Suite entities. Baïkal owns DAV resources. Google owns Google resources.
2. **Single-owner first, multi-user-ready.** All records carry owner identity. Authorization enforced at context boundaries.
3. **Preview before mutation.** Every automation mutation goes through no-side-effect preview; confirmation is a separate idempotent step.
4. **Idempotency everywhere.** Retriable creates require `Idempotency-Key`. Same key + hash replays original outcome.
5. **Conditional writes.** All DAV mutations use `If-None-Match: *` or `If-Match`. 412 → visible conflict, never silent overwrite.
6. **Server-authoritative time.** Server clock supplies all interval boundaries for active sessions.
7. **Fail closed.** Revoked sessions, expired tokens, lost keys, precondition failures all fail visibly and safely.
8. **Content-safe diagnostics.** Error responses, audit records, recovery manifests never contain task content, credentials, or stack traces.
```

- [ ] **Step 4: Verify glossary completeness**

Run `rg --include='*.ts' --include='*.tsx' -o '\b[A-Z][a-z]+([A-Z][a-z]+)+\b' apps/server/src/server.ts` and cross-check against glossary. Add any missing domain terms.

- [ ] **Step 5: Commit**

```bash
git add CONTEXT.md
git commit -m "docs: add CONTEXT.md domain glossary from ADRs"
```

---

### Task 1.2: Extract HTTP plumbing from server.ts

**Files:**
- Create: `apps/server/src/http-utils.ts`
- Modify: `apps/server/src/server.ts` (remove extracted functions, import from new module)

**Goal:** Move pure HTTP utilities out of the route handler file so route modules can import them independently.

- [ ] **Step 1: Extract `sendJson`, `sendError`, `readJson`**

Create `apps/server/src/http-utils.ts`:

```typescript
import { type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiError } from "@suite/contracts";

export const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
} as const;

export const sendJson = (
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void => {
  response.writeHead(status, {
    ...securityHeaders,
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(body));
};

export const sendError = (
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void => {
  const body: ApiError = { code, message, requestId: randomUUID() };
  sendJson(response, status, body);
};

export const maxJsonBytes = 5 * 1024 * 1024;

export const readJson = async (
  request: IncomingMessage,
): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += (chunk as Buffer).length;
    if (length > maxJsonBytes) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length === 0 ? undefined : JSON.parse(raw);
};
```

- [ ] **Step 2: Extract `sameOrigin`, `clientAddress`, `normalizedAddress`**

Add to `apps/server/src/http-utils.ts`:

```typescript
import { isIP } from "node:net";

export const sameOrigin = (request: IncomingMessage): boolean => {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin === undefined || host === undefined) return false;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.host === host &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
};

const normalizedAddress = (value: string): string =>
  value.startsWith("::ffff:") ? value.slice(7) : value;

export const clientAddress = (
  request: IncomingMessage,
  trustedProxyCidrs: readonly string[],
): string => {
  const remote = request.socket?.remoteAddress ?? "unknown";
  if (trustedProxyCidrs.length > 0) {
    const raw = normalizedAddress(remote);
    if (!isIP(raw)) return raw;
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string") {
      const trimmed = forwarded.split(",")[0]?.trim();
      if (trimmed !== undefined) return normalizedAddress(trimmed);
    }
    return raw;
  }
  return normalizedAddress(remote);
};
```

- [ ] **Step 3: Extract `expectedRevision`, `sendConditionalTask`**

Add to `apps/server/src/http-utils.ts`:

```typescript
import { conditionalRequestHeadersSchema } from "@suite/contracts";
import type { ConditionalTaskResult } from "@suite/persistence";

export const expectedRevision = (
  request: IncomingMessage,
  response: ServerResponse,
): number | undefined => {
  const header = request.headers["if-match"];
  if (header === undefined) {
    sendError(
      response,
      428,
      "PRECONDITION_REQUIRED",
      "A current task If-Match header is required",
    );
    return undefined;
  }
  const parsed = conditionalRequestHeadersSchema.safeParse({ ifMatch: header });
  if (!parsed.success) {
    sendError(
      response,
      400,
      "INVALID_PRECONDITION",
      "The task If-Match header is invalid",
    );
    return undefined;
  }
  return Number(parsed.data.ifMatch.slice(1, -1));
};

export const sendConditionalTask = (
  response: ServerResponse,
  result: ConditionalTaskResult,
  taskResponse: (record: { readonly revision: number }) => unknown,
): void => {
  if (result.kind === "not-found") {
    sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
    return;
  }
  if (result.kind === "precondition-failed") {
    sendError(
      response,
      412,
      "TASK_REVISION_CONFLICT",
      "The task changed; reload it before trying again",
    );
    return;
  }
  sendJson(response, 200, { task: taskResponse(result.task) }, {
    ETag: `"${String(result.task.revision)}"`,
  });
};
```

- [ ] **Step 4: Replace imports in server.ts**

Remove the extracted functions from `server.ts`. Add:

```typescript
import {
  sendJson,
  sendError,
  readJson,
  sameOrigin,
  clientAddress,
  expectedRevision,
  sendConditionalTask,
  securityHeaders,
} from "./http-utils.ts";
```

- [ ] **Step 5: Extract MIME types and security headers**

Move the `mimeTypes` constant and `securityHeaders` from server.ts into `http-utils.ts`. Both are already in Step 1 and Step 3 above — confirm no duplicates remain in server.ts.

- [ ] **Step 6: Verify**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/http-utils.ts apps/server/src/server.ts
git commit -m "refactor(server): extract HTTP plumbing into http-utils module"
```

---

### Task 1.3: Define persistence store interfaces

**Files:**
- Create: `packages/persistence/src/stores.ts` (interface definitions)
- No modifications to existing code yet — interfaces only

**Goal:** Define TypeScript interfaces for each bounded-context store. These become the seams that server modules and connector classes depend on instead of `SuiteDatabase`.

- [ ] **Step 1: Define all store interfaces**

Create `packages/persistence/src/stores.ts`:

```typescript
import type {
  OwnerRecord,
  SessionRecord,
  BaikalConnectorRecord,
  CalendarProviderRecord,
  CalendarCollectionRecord,
  TaskRecord,
  TaskPatch,
  ConditionalTaskResult,
  CalendarEventProjectionRecord,
  TaskCalendarBlockRecord,
  InstallationLock,
  GoogleConnectorRecord,
  GoogleCalendarSyncRecord,
  PlanningPreferencesRecord,
  NotificationPreferencesRecord,
  NotificationDeliveryRecord,
  SyncClientRecord,
  AutomationTokenRecord,
  AutomationPreviewRecord,
  AutomationOutcomeRecord,
  AutomationAuditRecord,
  TaskTemplateRecord,
  TemplateSubtaskBlueprintRecord,
  TemplateSetRecord,
  TemplateSetMemberRecord,
  TemplateInstantiationResult,
  ChoicePoolRecord,
  ChoicePoolItemRecord,
  ChoicePoolHistoryRecord,
  PlanningPlaceholderRecord,
  PlanningPlaceholderResolutionResult,
  PlanningPlaceholderResolutionRecord,
  TemplatePoolSlotRecord,
  CalendarImportJobRecord,
  CalendarImportItemRecord,
  CalendarFeedCapabilityRecord,
  PublishedCalendarRawRecord,
} from "./index.ts";

// ── Installation & Metadata ──
export interface MetadataStore {
  state(): { install: { instanceId: string; createdAt: string }; appliedMigrationCount: number; expectedMigrationCount: number };
  isSetupComplete(): boolean;
  claimInstallation(options: { instanceId: string; now: string }): boolean;
}

// ── Owner & Auth ──
export interface OwnerStore {
  createOwner(record: OwnerRecord): boolean;
  getOwner(): OwnerRecord | undefined;
  getOwnerByUsername(username: string): OwnerRecord | undefined;
}

export interface SessionStore {
  insertSession(record: SessionRecord & { readonly issuedAt: string }): void;
  getSession(tokenHash: string): SessionRecord | undefined;
  updateCsrf(tokenHash: string, csrfHash: string): void;
  revokeSession(tokenHash: string, revokedAt: string): boolean;
  purgeExpiredSessions(): void;
}

export interface CredentialStore {
  getBaikalConnector(ownerId: string): BaikalConnectorRecord | undefined;
  upsertBaikalConnector(record: BaikalConnectorRecord): void;
  deleteBaikalConnector(ownerId: string): void;
  upsertGoogleConnector(record: GoogleConnectorRecord): void;
  getGoogleConnector(ownerId: string): GoogleConnectorRecord | undefined;
  deleteGoogleConnector(ownerId: string): void;
  upsertGoogleCalendarSync(record: GoogleCalendarSyncRecord): void;
  listGoogleCalendarSync(ownerId: string): readonly GoogleCalendarSyncRecord[];
  clearGoogleCalendarSync(ownerId: string): boolean;
}

export interface PlanningPreferencesStore {
  getPlanningPreferences(ownerId: string): PlanningPreferencesRecord;
  upsertPlanningPreferences(ownerId: string, record: PlanningPreferencesRecord): void;
}

export interface NotificationPreferencesStore {
  getNotificationPreferences(ownerId: string): NotificationPreferencesRecord;
  upsertNotificationPreferences(ownerId: string, record: NotificationPreferencesRecord): void;
}

export interface NotificationDeliveryStore {
  claimDelivery(ownerId: string, taskId: string, occurrenceStart: string, kind: "lead" | "at_start", claimedAt: string): NotificationDeliveryRecord | undefined;
  getPendingDeliveries(ownerId: string): readonly NotificationDeliveryRecord[];
  countDeliveriesByTask(ownerId: string, taskId: string): number;
  markDeliveryFailed(ownerId: string, deliveryId: string, now: string): void;
  cancelPendingDeliveries(ownerId: string, taskId: string, now: string): void;
  insertDelivery(record: NotificationDeliveryRecord): void;
  reconcile(tasks: readonly string[], pendingIds: readonly string[], deliveredIds: readonly string[]): void;
}

// ── Tasks, Projects, Tags, Subtasks ──
export interface TaskStore {
  createTaskIdempotently(record: TaskRecord, idempotencyKey: string, requestHash: string): TaskRecord;
  listTasks(ownerId: string): readonly TaskRecord[];
  listRecoveryTasks(ownerId: string): readonly TaskRecord[];
  getTask(ownerId: string, taskId: string): TaskRecord | undefined;
  patchTask(ownerId: string, taskId: string, expectedRevision: number, patch: TaskPatch, now: string): ConditionalTaskResult;
  transitionTask(ownerId: string, taskId: string, expectedRevision: number, status: "open" | "completed", now: string): ConditionalTaskResult;
  softDeleteTask(ownerId: string, taskId: string, expectedRevision: number, now: string): ConditionalTaskResult;
  restoreTask(ownerId: string, taskId: string, now: string): TaskRecord | undefined;
  searchTasks(ownerId: string, query: string, status: "all" | "open" | "completed", projectId: string, tagId: string): readonly TaskRecord[];
}

export interface ProjectStore {
  createProject(record: { id: string; ownerId: string; title: string; revision: number; createdAt: string; updatedAt: string }): unknown;
  listProjects(ownerId: string): readonly unknown[];
  getProject(ownerId: string, projectId: string): unknown;
  patchProject(ownerId: string, projectId: string, title: string, now: string): unknown;
  archiveProject(ownerId: string, projectId: string, now: string): unknown;
}

export interface TagStore {
  createTag(record: { id: string; ownerId: string; displayName: string; uniquenessKey: string; revision: number; createdAt: string; updatedAt: string }): unknown;
  listTags(ownerId: string): readonly unknown[];
  getTag(ownerId: string, tagId: string): unknown;
  patchTag(ownerId: string, tagId: string, displayName: string, now: string): unknown;
  archiveTag(ownerId: string, tagId: string, now: string): unknown;
}

export interface SubtaskStore {
  createSubtask(record: { id: string; ownerId: string; taskId: string; title: string; position: number; revision: number }): unknown;
  listSubtasks(ownerId: string, taskId: string): readonly unknown[];
  patchSubtask(ownerId: string, subtaskId: string, title: string, completed: boolean, now: string): unknown;
  deleteSubtask(ownerId: string, subtaskId: string): boolean;
}

// ── Calendar Projections ──
export interface CalendarProjectionStore {
  listProjectedEvents(ownerId: string, from: string, to: string): readonly CalendarEventProjectionRecord[];
  listOwnedCalendars(ownerId: string): readonly unknown[];
  upsertProjectionBatch(records: readonly CalendarEventProjectionRecord[]): void;
  reserveCalendarWrite(ownerId: string, taskId: string, providerId: string, calendarHref: string, href: string, idempotencyKey: string, requestHash: string): unknown;
  completeCalendarWrite(operationId: string): void;
  getCalendarWrite(operationId: string): unknown;
  listTaskCalendarBlocks(ownerId: string, taskId: string): readonly TaskCalendarBlockRecord[];
  deleteTaskCalendarBlock(ownerId: string, blockId: string): boolean;
  listPublishedCalendarRaw(ownerId: string, calendarId: string): readonly PublishedCalendarRawRecord[];
}

// ── Sync ──
export interface SyncStore {
  createClientIdentity(record: unknown): unknown;
  listClientIdentities(ownerId: string): readonly SyncClientRecord[];
  updateClientLastSeen(ownerId: string, clientId: string, now: string): boolean;
  applyTaskFieldSync(ownerId: string, taskId: string, fields: Record<string, unknown>, now: string): unknown;
  getSyncOwnerState(ownerId: string): unknown;
  advanceSyncEpoch(ownerId: string): void;
  // ... additional sync methods from Phase 2
}

// ── Automation ──
export interface AutomationTokenStore {
  createToken(record: AutomationTokenRecord): void;
  listTokens(ownerId: string): readonly AutomationTokenRecord[];
  getTokenByPrefix(prefix: string): AutomationTokenRecord | undefined;
  deleteToken(ownerId: string, tokenId: string): boolean;
}

export interface AutomationPreviewStore {
  insertPreview(record: AutomationPreviewRecord): void;
  getPreview(ownerId: string, previewId: string): AutomationPreviewRecord | undefined;
  consumePreview(ownerId: string, previewId: string, now: string): boolean;
}

export interface AutomationAuditStore {
  insertOutcome(record: AutomationOutcomeRecord): void;
  insertAudit(record: AutomationAuditRecord): void;
  listAudit(ownerId: string): readonly AutomationAuditRecord[];
}

// ── Templates ──
export interface TemplateStore {
  createTemplate(record: TaskTemplateRecord): unknown;
  listTemplates(ownerId: string): readonly TaskTemplateRecord[];
  getTemplate(ownerId: string, templateId: string): TaskTemplateRecord | undefined;
  patchTemplate(ownerId: string, templateId: string, patch: Record<string, unknown>, now: string): unknown;
  archiveTemplate(ownerId: string, templateId: string, now: string): boolean;
  createTemplateFromTask(ownerId: string, taskId: string, templateRecord: TaskTemplateRecord, blueprintRecords: readonly TemplateSubtaskBlueprintRecord[], now: string): unknown;
  createTemplateSet(ownerId: string, setRecord: TemplateSetRecord, memberRecords: readonly TemplateSetMemberRecord[]): unknown;
  listTemplateSets(ownerId: string): readonly TemplateSetRecord[];
  getTemplateSet(ownerId: string, setId: string): unknown;
  instantiateTemplateIdempotently(ownerId: string, sourceKind: string, sourceId: string, idempotencyKey: string, requestHash: string, now: string): TemplateInstantiationResult;
}

// ── Choice Pools ──
export interface ChoicePoolStore {
  createChoicePool(record: ChoicePoolRecord): unknown;
  listChoicePools(ownerId: string): readonly ChoicePoolRecord[];
  getChoicePool(ownerId: string, poolId: string): ChoicePoolRecord | undefined;
  updateChoicePool(ownerId: string, poolId: string, patch: Record<string, unknown>, now: string): unknown;
  createChoicePoolItem(record: ChoicePoolItemRecord): unknown;
  listChoicePoolItems(poolId: string, includeArchived: boolean): readonly ChoicePoolItemRecord[];
  recordChoicePoolCompletion(ownerId: string, poolId: string, itemId: string, now: string): unknown;
  getChoicePoolHistory(poolId: string): readonly ChoicePoolHistoryRecord[];
  createPlanningPlaceholder(record: PlanningPlaceholderRecord): unknown;
  listPlanningPlaceholders(ownerId: string): readonly PlanningPlaceholderRecord[];
  getPlanningPlaceholder(ownerId: string, placeholderId: string): PlanningPlaceholderRecord | undefined;
  resolvePlanningPlaceholderIdempotently(options: Record<string, unknown>): PlanningPlaceholderResolutionResult;
  createTemplatePoolSlot(record: TemplatePoolSlotRecord): unknown;
  listTemplatePoolSlots(templateId: string): readonly TemplatePoolSlotRecord[];
}

// ── Calendar Import/Export ──
export interface CalendarImportStore {
  createImportJob(record: CalendarImportJobRecord): unknown;
  getImportJob(ownerId: string, jobId: string): CalendarImportJobRecord | undefined;
  createImportItem(record: CalendarImportItemRecord): unknown;
  listImportItems(jobId: string): readonly CalendarImportItemRecord[];
  applyImportItem(ownerId: string, itemId: string, href: string, now: string): unknown;
}

export interface CalendarFeedStore {
  createFeedCapability(record: CalendarFeedCapabilityRecord): void;
  getCalendarFeedCapability(feedId: string): CalendarFeedCapabilityRecord | undefined;
  listCalendarFeeds(ownerId: string): readonly unknown[];
  revokeCalendarFeed(ownerId: string, feedId: string, now: string): boolean;
}

// ── Composed server dependencies ──
export interface ServerStores {
  readonly metadata: MetadataStore;
  readonly owners: OwnerStore;
  readonly sessions: SessionStore;
  readonly credentials: CredentialStore;
  readonly planningPreferences: PlanningPreferencesStore;
  readonly notificationPreferences: NotificationPreferencesStore;
  readonly notificationDeliveries: NotificationDeliveryStore;
  readonly tasks: TaskStore;
  readonly projects: ProjectStore;
  readonly tags: TagStore;
  readonly subtasks: SubtaskStore;
  readonly calendarProjections: CalendarProjectionStore;
  readonly sync: SyncStore;
  readonly automationTokens: AutomationTokenStore;
  readonly automationPreviews: AutomationPreviewStore;
  readonly automationAudit: AutomationAuditStore;
  readonly templates: TemplateStore;
  readonly choicePools: ChoicePoolStore;
  readonly calendarImports: CalendarImportStore;
  readonly calendarFeeds: CalendarFeedStore;
}
```

- [ ] **Step 5: Verify interface coverage**

For each method in `SuiteDatabase` (find via `rg '^\s+[a-z][a-zA-Z]+\(.*\):' packages/persistence/src/index.ts`), verify it appears in the corresponding store interface above. Update interfaces for any gaps.

- [ ] **Step 6: Verify**

```bash
pnpm typecheck && pnpm lint
```

- [ ] **Step 7: Commit**

```bash
git add packages/persistence/src/stores.ts
git commit -m "refactor(persistence): define bounded-context store interfaces"
```

---

## Phase 2: Store Splitting & Automation Client

After Phase 1 completes, these two workstreams can run in parallel.

### Task 2.1: Implement MetadataStore, OwnerStore, SessionStore

**Files:**
- Create: `packages/persistence/src/metadata-store.ts`
- Create: `packages/persistence/src/owner-store.ts`
- Create: `packages/persistence/src/session-store.ts`
- Modify: `packages/persistence/src/index.ts` (delegate to new stores)

**Goal:** Extract the first three stores from SuiteDatabase. Each store takes `DatabaseSync` as constructor arg and implements the corresponding interface from `stores.ts`.

- [ ] **Step 1: Extract MetadataStore**

Create `packages/persistence/src/metadata-store.ts`:

```typescript
import type { DatabaseSync } from "node:sqlite";
import type { MetadataStore } from "./stores.ts";

export class SqliteMetadataStore implements MetadataStore {
  constructor(private readonly db: DatabaseSync) {}

  state() {
    // Move SuiteDatabase.state() implementation here
    // For now, access through the db directly
    const install = this.db.prepare("SELECT instance_id, created_at FROM install_metadata").get() as { instance_id: string; created_at: string } | undefined;
    const migrationCount = this.db.prepare("SELECT COUNT(*) as count FROM _migrations").get() as { count: number };
    const expected = this.db.prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name LIKE 'migration_%'").get() as { count: number };
    // Note: exact implementation uses existing SuiteDatabase logic
    return {
      install: install ? { instanceId: install.instance_id, createdAt: install.created_at } : { instanceId: "uninitialized", createdAt: new Date(0).toISOString() },
      appliedMigrationCount: migrationCount.count,
      expectedMigrationCount: expected.count,
    };
  }

  isSetupComplete(): boolean {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM owner_accounts").get() as { count: number };
    return row.count > 0;
  }

  claimInstallation(options: { instanceId: string; now: string }): boolean {
    // Move SuiteDatabase.claimInstallation() logic
    const existing = this.db.prepare("SELECT instance_id FROM install_metadata").get();
    if (existing) {
      const row = this.db.prepare("SELECT instance_id FROM install_metadata WHERE instance_id = ?").get(options.instanceId);
      return row !== undefined;
    }
    this.db.prepare("INSERT INTO install_metadata (instance_id, created_at) VALUES (?, ?)").run(options.instanceId, options.now);
    return true;
  }
}
```

- [ ] **Step 2: Extract OwnerStore and SessionStore**

Following the same pattern, create `owner-store.ts` and `session-store.ts` with `SqliteOwnerStore` and `SqliteSessionStore` classes. Each moves its methods from SuiteDatabase verbatim.

- [ ] **Step 3: Update SuiteDatabase to delegate**

```typescript
import { SqliteMetadataStore } from "./metadata-store.ts";
import { SqliteOwnerStore } from "./owner-store.ts";
import { SqliteSessionStore } from "./session-store.ts";

export class SuiteDatabase {
  readonly metadata: SqliteMetadataStore;
  readonly owners: SqliteOwnerStore;
  readonly sessions: SqliteSessionStore;
  // ... more stores added in subsequent tasks

  // Keep existing public API as delegation for backward compat
  state() { return this.metadata.state(); }
  isSetupComplete() { return this.metadata.isSetupComplete(); }
  claimInstallation(opts: { instanceId: string; now: string }) { return this.metadata.claimInstallation(opts); }
  // ... etc
}
```

- [ ] **Step 4: Verify**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

- [ ] **Step 5: Commit**

```bash
git add packages/persistence/src/
git commit -m "refactor(persistence): extract metadata, owner, and session stores"
```

---

### Tasks 2.2–2.7: Extract remaining stores

*(Same pattern: extract 2–3 stores per task, each task self-verifies with `pnpm typecheck && pnpm test`. Commit after each task.)*

**Task 2.2:** Extract `TaskStore`, `ProjectStore`, `TagStore`, `SubtaskStore`
**Task 2.3:** Extract `CredentialStore`, `CalendarProjectionStore`, `PlanningPreferencesStore`
**Task 2.4:** Extract `SyncStore`
**Task 2.5:** Extract `AutomationTokenStore`, `AutomationPreviewStore`, `AutomationAuditStore`
**Task 2.6:** Extract `TemplateStore`
**Task 2.7:** Extract `ChoicePoolStore`, `NotificationStore`, `CalendarImportStore`, `CalendarFeedStore`

Each follows the pattern from Task 2.1:
1. Create `packages/persistence/src/{context}-store.ts` with `Sqlite{Context}Store implements {Context}Store`
2. Move methods from `SuiteDatabase` verbatim
3. Update `SuiteDatabase` to delegate
4. Run `pnpm typecheck && pnpm test`
5. Commit

---

### Task 2.8: Refactor server callers to use store interfaces

**Files:**
- Modify: `apps/server/src/server.ts` — replace `database.xxx()` with `stores.xxx.xxx()`
- Modify: `apps/server/src/connector.ts` — narrow parameter type to `CredentialStore & CalendarProjectionStore`
- Modify: `apps/server/src/google-connector.ts` — narrow parameter type
- Modify: `apps/server/src/auth.ts` — narrow parameter type to `OwnerStore & SessionStore`
- Modify: `apps/server/src/notifications.ts` — narrow parameter type

**Goal:** Callers depend on `ServerStores` instead of `SuiteDatabase`. This creates real seams.

- [ ] **Step 1: Update server.ts to use stores**

If `SuiteDatabase` now has `.metadata`, `.owners`, `.sessions`, etc. properties, update:

```typescript
// Before:
const owner = database.getOwnerByUsername(username);
// After:
const owner = stores.owners.getOwnerByUsername(username);
```

Where `stores` is typed as `ServerStores` from `stores.ts`.

- [ ] **Step 2: Narrow connector parameter types**

```typescript
// connector.ts — before:
class BaikalConnectorService {
  constructor(private readonly database: SuiteDatabase) {}
// connector.ts — after:
import type { CredentialStore, CalendarProjectionStore } from "@suite/persistence/stores";
class BaikalConnectorService {
  constructor(
    private readonly credentials: CredentialStore,
    private readonly projections: CalendarProjectionStore,
  ) {}
```

- [ ] **Step 3: Verify**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/
git commit -m "refactor(server): narrow persistence dependencies to store interfaces"
```

---

### Task 2.9: Unify automation client generation from catalog

**Files:**
- Modify: `packages/contracts/src/index.ts` — add `AutomationApiClient` class
- Modify: `apps/web/src/api.ts` — replace hand-written fetch wrappers
- Modify: `apps/mcp-stdio/src/protocol.ts` — use generated client
- Modify: `apps/quick-add/src/client.ts` — use generated client

**Goal:** The `automationCatalog` already declares HTTP paths, methods, and Zod schemas. Generate a typed HTTP client from it. All three apps (web, mcp-stdio, quick-add) use the same client.

- [ ] **Step 1: Create generated client**

Add to `packages/contracts/src/index.ts`:

```typescript
import type { z } from "zod";

export interface CatalogEntryBase {
  readonly id: string;
  readonly kind: "resource" | "tool";
  readonly apiPath: string;
  readonly inputSchema: z.ZodTypeAny;
  readonly outputSchema: z.ZodTypeAny;
}

export type AutomationInput<T extends CatalogEntryBase> = z.input<T["inputSchema"]>;
export type AutomationOutput<T extends CatalogEntryBase> = z.output<T["outputSchema"]>;

export const createAutomationClient = (
  baseUrl: string,
  getAuthHeaders: () => Record<string, string>,
) => {
  const call = async <T extends CatalogEntryBase>(
    entry: T,
    input: AutomationInput<T>,
  ): Promise<AutomationOutput<T>> => {
    const response = await fetch(`${baseUrl}${entry.apiPath}`, {
      method: entry.kind === "resource" ? "GET" : "POST",
      headers: {
        ...getAuthHeaders(),
        "Content-Type": "application/json",
      },
      body: entry.kind === "tool" ? JSON.stringify(input) : undefined,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new ApiRequestError(
        response.status,
        error.code ?? "REQUEST_FAILED",
        error.message ?? "Request failed",
        error.requestId,
      );
    }
    return entry.outputSchema.parse(await response.json()) as AutomationOutput<T>;
  };
  return { call };
};
```

- [ ] **Step 2: Add typed catalog accessors**

```typescript
// Find an entry by operation ID with type narrowing
export const findCatalogEntry = <T extends CatalogEntryBase>(
  id: string,
): T => {
  const entry = automationCatalog.find(e => e.id === id);
  if (!entry) throw new Error(`Catalog entry not found: ${id}`);
  return entry as unknown as T;
};
```

- [ ] **Step 3: Migrate web/api.ts to use generated client**

The 49 exported functions become thin wrappers around catalog entries. Each function imports the client and the relevant entry:

```typescript
import { createAutomationClient, findCatalogEntry } from "@suite/contracts";

const client = createAutomationClient("", () => ({
  "X-CSRF-Token": getCsrfToken(),
}));

export const getTasks = (csrfToken: string): Promise<TaskListResponse> =>
  client.call(findCatalogEntry("tasks.list"), {});
```

Actually, for the web app, most calls are session-authenticated (same-origin + CSRF), not automation-token-authenticated. The approach should be: the existing `api.ts` functions stay but use a shared `request()` helper that constructs URLs and validates responses with Zod schemas from the catalog. The catalog becomes the schema authority, not a full client replacement.

- [ ] **Step 4: Create shared fetch helper in contracts**

```typescript
// packages/contracts/src/http-client.ts
export const createHttpClient = (baseUrl: string) => ({
  async request<T extends CatalogEntryBase>(
    entry: T,
    input: unknown,
    headers: Record<string, string> = {},
  ): Promise<z.output<T["outputSchema"]>> {
    entry.inputSchema.parse(input);
    const response = await fetch(`${baseUrl}${entry.apiPath}`, {
      method: entry.kind === "resource" ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: entry.kind === "tool" ? JSON.stringify(input) : undefined,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new ApiRequestError(response.status, error.code, error.message, error.requestId);
    }
    const raw = await response.json();
    return entry.outputSchema.parse(raw);
  },
});

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}
```

The `apps/web/src/api.ts` functions then become:

```typescript
import { createHttpClient, findCatalogEntry, ApiRequestError } from "@suite/contracts";

const client = createHttpClient("");

export const getTasks = async (csrfToken: string): Promise<TaskListResponse> => {
  const entry = findCatalogEntry("tasks.list");
  return client.request(entry, {}, { "X-CSRF-Token": csrfToken });
};

export const createTask = async (
  input: { title: string; notes?: string; idempotencyKey: string; plannedStart?: string | null },
  csrfToken: string,
): Promise<TaskMutationResponse> => {
  const entry = findCatalogEntry("tasks.create");
  return client.request(entry, input, { "X-CSRF-Token": csrfToken });
};
```

- [ ] **Step 5: Migrate quick-add**

```typescript
// apps/quick-add/src/client.ts
import { createHttpClient, findCatalogEntry } from "@suite/contracts";

export const submitQuickAdd = async (config: { url: string; token: string }, title: string, options: { notes?: string; idempotencyKey: string }) => {
  const client = createHttpClient(config.url);
  // Step 1: Preview
  const previewEntry = findCatalogEntry("tasks.create");
  const preview = await client.request(previewEntry, { title, notes: options.notes, idempotencyKey: options.idempotencyKey }, {
    Authorization: `Bearer ${config.token}`,
  });
  // Step 2: Confirm
  if (preview.requiresConfirmation) {
    const confirmEntry = findCatalogEntry("automation.confirm");
    return client.request(confirmEntry, { previewId: preview.previewId }, {
      Authorization: `Bearer ${config.token}`,
    });
  }
  return preview;
};
```

- [ ] **Step 6: Migrate mcp-stdio**

The MCP protocol handler already constructs HTTP requests manually. Update to use `createHttpClient`:

```typescript
import { createHttpClient, findCatalogEntry } from "@suite/contracts";

// In tool execution:
const client = createHttpClient(config.apiUrl);
const entry = findCatalogEntry(tool.http.path); // maps from tool name to catalog entry
const result = await client.request(entry, args, {
  Authorization: `Bearer ${config.token}`,
});
```

- [ ] **Step 7: Verify**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/src/ apps/web/src/api.ts apps/quick-add/src/client.ts apps/mcp-stdio/src/protocol.ts
git commit -m "refactor: unify automation client generation from catalog"
```

---

## Phase 3: Break server.ts into route modules

Each task extracts one bounded context's route handlers into its own module. After each task, `server.ts` shrinks. The final task makes `server.ts` a thin dispatcher.

Every route module follows the same signature:

```typescript
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerStores } from "@suite/persistence/stores";
import type { AuthService } from "./auth.ts";
// ... other dependencies

export interface RouteContext {
  readonly stores: ServerStores;
  readonly auth: AuthService;
  readonly config: ServerConfig;
  // ... other shared dependencies
}

export type RouteHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
  url: URL,
) => Promise<boolean> | boolean;
// Returns true if route was handled, false if not matched
```

### Task 3.1: Extract health/metrics/build/readiness routes

**Files:**
- Create: `apps/server/src/routes/health.ts`
- Modify: `apps/server/src/server.ts` (delegate)

- [ ] **Step 1: Create health routes module**

`apps/server/src/routes/health.ts`:

```typescript
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerConfig } from "../config.ts";
import type { ServerStores } from "@suite/persistence/stores";
import { sendJson } from "../http-utils.ts";

export const handleHealth = async (
  request: IncomingMessage,
  response: ServerResponse,
  stores: ServerStores,
  config: ServerConfig,
  url: URL,
  startedAt: number,
  requestCounts: Map<number, number>,
): Promise<boolean> => {
  const { method, pathname } = url;

  if (method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, {
      service: "productivity-suite",
      status: "ok",
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/metrics") {
    const state = stores.metadata.state();
    const lines = [
      "# HELP suite_uptime_seconds Process uptime in seconds.",
      "# TYPE suite_uptime_seconds gauge",
      `suite_uptime_seconds ${String(Math.floor((Date.now() - startedAt) / 1000))}`,
      "# HELP suite_database_migrations Applied SQLite migrations.",
      "# TYPE suite_database_migrations gauge",
      `suite_database_migrations ${String(state.appliedMigrationCount)}`,
      "# HELP suite_http_requests_total Completed HTTP responses by status.",
      "# TYPE suite_http_requests_total counter",
      ...[...requestCounts.entries()]
        .sort(([left], [right]) => left - right)
        .map(([status, count]) => `suite_http_requests_total{status="${String(status)}"} ${String(count)}`),
      "",
    ];
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    });
    response.end(lines.join("\n"));
    return true;
  }

  if (method === "GET" && pathname === "/api/build") {
    sendJson(response, 200, { service: "productivity-suite", ...config.build });
    return true;
  }

  if (method === "GET" && pathname === "/api/ready") {
    const state = stores.metadata.state();
    sendJson(response, 200, {
      service: "productivity-suite",
      status: state.appliedMigrationCount >= state.expectedMigrationCount ? "ok" : "not_ready",
      checks: {
        database: "ok" as const,
        migrations: state.appliedMigrationCount >= state.expectedMigrationCount ? ("current" as const) : ("pending" as const),
      },
      instanceId: state.install.instanceId,
      migrationCount: state.appliedMigrationCount,
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  return false;
};
```

- [ ] **Step 2: Wire into server.ts**

In the server handler, near the top (after URL parsing, before any auth checks):

```typescript
const handled = await handleHealth(request, response, stores, config, url, startedAt, requestCounts);
if (handled) {
  requestCounts.set(resolvedStatus, (requestCounts.get(resolvedStatus) ?? 0) + 1);
  return;
}
```

Remove the inline health/metrics/build/readiness handlers from server.ts.

- [ ] **Step 3: Verify**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/routes/health.ts apps/server/src/server.ts
git commit -m "refactor(server): extract health/metrics/build/readiness route module"
```

---

### Tasks 3.2–3.12: Extract remaining route modules

*(Same pattern: create `apps/server/src/routes/{context}.ts`, wire into server.ts dispatcher, verify, commit.)*

**Task 3.2:** Extract `routes/auth-setup.ts` — owner setup, login, logout, session
**Task 3.3:** Extract `routes/tasks.ts` — task CRUD, complete/reopen, delete/restore, time blocks, search
**Task 3.4:** Extract `routes/planner.ts` — planner, day-plan, planning preferences
**Task 3.5:** Extract `routes/connectors.ts` — Baïkal connect/status, Google OAuth/sync/disconnect
**Task 3.6:** Extract `routes/sync.ts` — client registration, sync round, sync snapshot
**Task 3.7:** Extract `routes/active-session.ts` — get, command
**Task 3.8:** Extract `routes/projects.ts` + `routes/tags.ts` + `routes/subtasks.ts`
**Task 3.9:** Extract `routes/templates.ts` — CRUD, template sets, instantiation, pool slots
**Task 3.10:** Extract `routes/choice-pools.ts` — pools, items, completions, placeholders, suggestions, resolution
**Task 3.11:** Extract `routes/calendar.ts` — import preview/apply, feeds, publication
**Task 3.12:** Extract `routes/automation.ts` — tokens, resources, previews, confirmations, audit
**Task 3.13:** Extract `routes/notifications.ts` — preferences, status, test
**Task 3.14:** Extract `routes/static.ts` — static file serving, SPA fallback, capability URLs

---

### Task 3.15: Server dispatcher

**Files:**
- Modify: `apps/server/src/server.ts` (now ~200 lines, thin dispatcher)

**Goal:** server.ts becomes a thin dispatcher that creates `RouteContext`, then delegates to route modules in order.

```typescript
import { createServer } from "node:http";
import { URL } from "node:url";
import { SuiteDatabase } from "@suite/persistence";
import { AuthService, LoginRateLimiter } from "./auth.ts";
import { BaikalConnectorService } from "./connector.ts";
import { GoogleConnectorService } from "./google-connector.ts";
import { NtfyPublisher, loadNtfyPublisherConfig } from "./notifications.ts";
import { securityHeaders } from "./http-utils.ts";
import type { ServerConfig } from "./config.ts";

import { handleHealth } from "./routes/health.ts";
import { handleAuthSetup } from "./routes/auth-setup.ts";
import { handleTasks } from "./routes/tasks.ts";
import { handlePlanner } from "./routes/planner.ts";
import { handleConnectors } from "./routes/connectors.ts";
import { handleSync } from "./routes/sync.ts";
import { handleActiveSession } from "./routes/active-session.ts";
import { handleProjects } from "./routes/projects.ts";
import { handleTags } from "./routes/tags.ts";
import { handleSubtasks } from "./routes/subtasks.ts";
import { handleTemplates } from "./routes/templates.ts";
import { handleChoicePools } from "./routes/choice-pools.ts";
import { handleCalendar } from "./routes/calendar.ts";
import { handleAutomation } from "./routes/automation.ts";
import { handleNotifications } from "./routes/notifications.ts";
import { handleStatic } from "./routes/static.ts";

export const startSuiteServer = (config: ServerConfig) => {
  const database = SuiteDatabase.open(config.databasePath);
  const auth = new AuthService(database);
  const loginLimiter = new LoginRateLimiter();
  const baikal = new BaikalConnectorService(
    database.credentials,
    database.calendarProjections,
  );
  const google = new GoogleConnectorService(/* ... */);
  const ntfy = loadNtfyPublisherConfig(config) ? new NtfyPublisher(/* ... */) : undefined;

  const stores = database; // SuiteDatabase implements ServerStores

  const routeModules = [
    handleHealth,
    handleAuthSetup,
    handleTasks,
    handlePlanner,
    handleConnectors,
    handleSync,
    handleActiveSession,
    handleProjects,
    handleTags,
    handleSubtasks,
    handleTemplates,
    handleChoicePools,
    handleCalendar,
    handleAutomation,
    handleNotifications,
    handleStatic,
  ];

  const requestCounts = new Map<number, number>();
  const startedAt = Date.now();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    
    // Apply security headers to all responses via a wrapper
    // ... (wrap response for status tracking)

    for (const handler of routeModules) {
      const handled = await handler(request, response, { stores, auth, config, baikal, google, ntfy, loginLimiter }, url);
      if (handled) return;
    }

    // 404 fallback
    response.writeHead(404, { ...securityHeaders, "Content-Type": "text/plain" });
    response.end("Not Found");
  });

  return { server, database, auth };
};
```

- [ ] **Step 2: Verify**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/
git commit -m "refactor(server): extract all routes into bounded-context modules"
```

---

## Phase 4: Break app.tsx into page components

### Task 4.1: Extract shared types and hooks

**Files:**
- Create: `apps/web/src/state.ts`
- Create: `apps/web/src/hooks.ts`

- [ ] **Step 1: Extract shared types**

Create `apps/web/src/state.ts`:

```typescript
import type { SessionResponse, BaikalStatusResponse, Task, Project, Tag, Subtask, PlannerResponse, ActiveSession, TemplateView, TemplateBlueprintView, TemplateSetView, ChoicePool, ChoicePoolItem, ChoicePoolHistoryEvent, PlanningPlaceholder, GoogleConnectorStatusResponse, PlanningPreferences, DayPlanResponse, NotificationPreferences, NotificationStatusResponse, TemplatePoolSlot } from "@suite/contracts";
import type { LocalClientIdentity } from "./local-store.ts";

export type { WorkspaceRoute } from "./app.tsx";

export const workspaceRoutes = ["today", "tasks", "reuse", "connections", "settings"] as const;
export type WorkspaceRoute = (typeof workspaceRoutes)[number];

export const routeFromPath = (path: string): WorkspaceRoute =>
  workspaceRoutes.find((route) => route === path.replace(/^\//, "").split("/")[0]) ?? "today";

export type AppState =
  | { readonly kind: "loading" }
  | { readonly kind: "setup"; readonly username?: string }
  | { readonly kind: "login"; readonly username?: string; readonly message?: string }
  | { readonly kind: "authenticated"; readonly session: SessionResponse; readonly baikal: BaikalStatusResponse; readonly tasks: readonly Task[]; readonly recovery: readonly Task[]; readonly planner: PlannerResponse | null; readonly google?: GoogleConnectorStatusResponse; readonly planningPreferences?: PlanningPreferences; readonly dayPlan?: DayPlanResponse; readonly notificationPreferences?: NotificationPreferences; readonly notificationStatus?: NotificationStatusResponse; readonly client?: LocalClientIdentity; readonly activeSession?: ActiveSession | null; readonly syncStatus?: "online" | "offline" | "syncing"; readonly conflictCount?: number }
  | { readonly kind: "offline"; readonly tasks: readonly Task[]; readonly recovery: readonly Task[]; readonly conflictCount: number; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

// Page-level props — each page only receives what it needs
export interface PageProps {
  readonly busy: boolean;
  readonly setBusy: (busy: boolean) => void;
  readonly setFormError: (error: string | null) => void;
}

export interface TodayPageProps extends PageProps {
  readonly tasks: readonly Task[];
  readonly recovery: readonly Task[];
  readonly planner: PlannerResponse | null;
  readonly dayPlan?: DayPlanResponse;
  readonly activeSession?: ActiveSession | null;
  readonly clientId?: string | null;
  readonly syncStatus?: "online" | "offline" | "syncing";
  readonly onFocusCommand: (command: FocusPanelCommand) => void;
  readonly onSubmitTask: (event: SyntheticEvent<HTMLFormElement>) => void;
  // ...
}

// ... similar for TasksPageProps, ReusePageProps, etc.
```

- [ ] **Step 2: Extract shared hooks**

Create `apps/web/src/hooks.ts` with common pattern hooks:
- `useBusy` — sets busy flag during async operations
- `useCsrfToken` — reads CSRF from session state
- `useSyncStatus` — wraps SyncEngine status tracking

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/state.ts apps/web/src/hooks.ts
git commit -m "refactor(web): extract shared types and hooks from app.tsx"
```

---

### Tasks 4.2–4.6: Extract page components

*(Each task: create page component, wire into app.tsx, run web tests, commit.)*

**Task 4.2:** Extract `pages/TodayPage.tsx` — calm day status, focus panel, week planner, task capture form
**Task 4.3:** Extract `pages/TasksPage.tsx` — task list, search, filters, project/tag management, subtask editing
**Task 4.4:** Extract `pages/ReusePage.tsx` — template library, template sets, choice pool library
**Task 4.5:** Extract `pages/ConnectionsPage.tsx` — Baïkal status, Google auth/sync, calendar migration, calendar feeds
**Task 4.6:** Extract `pages/SettingsPage.tsx` — notification settings, sync now button

---

### Task 4.7: App.tsx becomes thin router

**Files:**
- Modify: `apps/web/src/app.tsx` (now ~200 lines)

```typescript
export const App = ({ initialState, initialPath }: AppProps) => {
  const [state, setState] = useState<AppState>(initialState ?? { kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [route, setRoute] = useState<WorkspaceRoute>(() => routeFromPath(initialPath ?? window.location.pathname));

  // On-mount data loading (moved to a custom hook)
  useEffect(() => { /* initial load */ }, []);

  // Route history
  useEffect(() => {
    const onPopState = () => setRoute(routeFromPath(location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  if (state.kind === "loading") return <p>Loading…</p>;
  if (state.kind === "setup") return <SetupPage state={state} />;
  if (state.kind === "login") return <LoginPage state={state} />;
  if (state.kind === "error") return <div>{state.message}</div>;
  if (state.kind === "offline") return <div>{state.message}</div>;

  // Authenticated — render route
  return (
    <>
      <nav>{/* route tabs */}</nav>
      {route === "today" && <TodayPage state={state} busy={busy} setBusy={setBusy} setFormError={setFormError} {...callbacks} />}
      {route === "tasks" && <TasksPage state={state} busy={busy} setBusy={setBusy} setFormError={setFormError} {...callbacks} />}
      {route === "reuse" && <ReusePage state={state} busy={busy} setBusy={setBusy} setFormError={setFormError} {...callbacks} />}
      {route === "connections" && <ConnectionsPage state={state} busy={busy} setBusy={setBusy} setFormError={setFormError} {...callbacks} />}
      {route === "settings" && <SettingsPage state={state} busy={busy} setBusy={setBusy} setFormError={setFormError} {...callbacks} />}
      {formError !== null && <p className="form-error">{formError}</p>}
    </>
  );
};
```

- [ ] **Step 2: Verify**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/
git commit -m "refactor(web): extract page components from monolith app.tsx"
```

---

## Success Gates

At every phase boundary, verify:

| Check | Command |
|---|---|
| TypeScript compiles | `pnpm typecheck` |
| Linter passes | `pnpm lint` |
| All tests pass | `pnpm test` |
| Server starts | `pnpm dev` (manual smoke test) |
| Build succeeds | `pnpm build` |

After Phase 4 (final), also verify:
- `apps/server/src/server.ts` is <300 lines
- `apps/web/src/app.tsx` is <300 lines
- `packages/persistence/src/index.ts` delegates to store modules
- All 7 deepening candidates addressed
- CONTEXT.md glossary is complete and referenced by ADRs

---

## Files Summary

| Before | After | Δ |
|---|---|---|
| `apps/server/src/server.ts` (6884L) | `apps/server/src/server.ts` (~200L) + 14 route modules (~200–400L each) | Better locality |
| `apps/web/src/app.tsx` (2560L) | `apps/web/src/app.tsx` (~200L) + 5 page modules (~200–500L each) | Better locality |
| `packages/persistence/src/index.ts` (6477L) | `index.ts` (~200L facade) + 14 store modules (~100–400L each) | Seams created |
| `packages/contracts/src/index.ts` (1872L) | plus `http-client.ts` (~50L) | Shared client |
| `apps/web/src/api.ts` (951L, 49 functions) | ~49 thin wrappers around catalog entries | Single source of truth |
| (new) `CONTEXT.md` | Domain glossary | AI-navigability |
