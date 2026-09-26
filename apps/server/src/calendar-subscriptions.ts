import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { lookup } from "node:dns/promises";
import type {
  CalendarSubscription,
  CalendarSubscriptionConversionResponse,
  CalendarSubscriptionCreateRequest,
  CalendarSubscriptionEvent,
  CalendarSubscriptionFetchResult,
  CalendarSubscriptionPatchRequest,
  CalendarSubscriptionRefreshResponse,
} from "@suite/contracts";
import { calendarSubscriptionMaxCount } from "@suite/contracts";
import {
  checkSubscriptionUrl,
  isBlockedSubscriptionHost,
  isSafeSubscriptionFilter,
  nextSubscriptionFetchAt,
  subscriptionFreshness,
  subscriptionRefreshBounds,
  zonedDayWindow,
  type SubscriptionUrlRejection,
} from "@suite/domain";
import { icsMaxBytes, parseIcalFeed } from "@suite/import-export";
import type {
  CalendarSubscriptionEventRecord,
  CalendarSubscriptionRecord,
  CalendarSubscriptionSettings,
  CalendarSubscriptionUrlCipher,
  SuiteDatabase,
  TaskRecord,
} from "@suite/persistence";
import { loadOrCreateCredentialKey } from "./connector.ts";
import { taskResponse } from "./routes/shared.ts";

/**
 * Read-only iCal subscriptions (issue #91, ADR 0032).
 *
 * The feed address is encrypted with the connector credential key
 * (AES-256-GCM, AAD bound to owner, subscription and key ID) and decrypted
 * only for a fetch. Nothing here logs, returns or embeds the address: error
 * classes are bounded tokens and responses carry the host alone. Fetches
 * refuse loopback, link-local and metadata addresses before and after DNS
 * resolution, follow at most three same-policy redirects, time out, and
 * cap the body at the ICS parser limit. Subscriptions never write upstream.
 */

export type AddressLookup = (hostname: string) => Promise<readonly string[]>;

export interface CalendarSubscriptionServiceOptions {
  readonly fetch?: typeof fetch;
  readonly lookup?: AddressLookup;
  readonly random?: () => number;
  readonly timeoutMs?: number;
}

export type SubscriptionWriteFailure =
  | { readonly kind: "limit" }
  | { readonly kind: "invalid_url"; readonly reason: SubscriptionUrlRejection }
  | { readonly kind: "invalid_filter" }
  | { readonly kind: "not_found" }
  | {
      readonly kind: "conflict";
      readonly subscription?: CalendarSubscription;
    };

export type SubscriptionWriteResult =
  | { readonly kind: "ok"; readonly subscription: CalendarSubscription }
  | SubscriptionWriteFailure;

export type EventConversionResult =
  | ({ readonly kind: "ok" } & CalendarSubscriptionConversionResponse)
  | { readonly kind: "not_found" }
  | { readonly kind: "reference_only" };

export type EventStateResult =
  | { readonly kind: "ok"; readonly event: CalendarSubscriptionEvent }
  | { readonly kind: "not_found" };

/** Saved-event window around a fetch: recent past, one year ahead. */
const windowBeforeMs = 30 * 24 * 60 * 60 * 1000;
const windowAfterMs = 400 * 24 * 60 * 60 * 1000;
const maxRedirects = 3;
/** Failed fetches retry sooner than the configured interval. */
const failureRetryMinutes = 30;

const defaultLookup: AddressLookup = async (hostname) =>
  (await lookup(hostname, { all: true })).map(({ address }) => address);

const aad = (ownerId: string, subscriptionId: string, keyId: string): Buffer =>
  Buffer.from(`suite-ical-v1\0${ownerId}\0${subscriptionId}\0${keyId}`);

const defaultSettings: CalendarSubscriptionSettings = {
  name: "",
  refreshIntervalMinutes: subscriptionRefreshBounds.defaultMinutes,
  color: null,
  icon: null,
  includePattern: null,
  excludePattern: null,
  referenceOnly: false,
  autoImport: false,
  enabled: true,
  hidden: false,
};

const normalizeFilter = (value: string | null | undefined): string | null =>
  value === undefined || value === null || value.trim() === "" ? null : value;

const filtersUsable = (settings: {
  readonly includePattern: string | null;
  readonly excludePattern: string | null;
}): boolean =>
  [settings.includePattern, settings.excludePattern].every(
    (pattern) => pattern === null || isSafeSubscriptionFilter(pattern),
  );

export const subscriptionResponse = (
  record: CalendarSubscriptionRecord,
  now: string,
): CalendarSubscription => ({
  id: record.id,
  ownerId: record.ownerId,
  revision: record.revision,
  name: record.name,
  urlHost: record.urlHost,
  refreshIntervalMinutes: record.refreshIntervalMinutes,
  color: record.color,
  icon: record.icon,
  includePattern: record.includePattern,
  excludePattern: record.excludePattern,
  referenceOnly: record.referenceOnly,
  autoImport: record.autoImport,
  enabled: record.enabled,
  hidden: record.hidden,
  freshness: subscriptionFreshness(record, now),
  lastAttemptAt: record.lastAttemptAt,
  lastSuccessAt: record.lastSuccessAt,
  lastErrorClass: record.lastErrorClass,
  nextFetchAt: record.nextFetchAt,
  eventCount: record.eventCount,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

export const subscriptionEventResponse = (
  event: CalendarSubscriptionEventRecord,
): CalendarSubscriptionEvent => ({
  subscriptionId: event.subscriptionId,
  subscriptionName: event.subscriptionName,
  referenceOnly: event.referenceOnly,
  uid: event.uid,
  occurrenceStart: event.occurrenceStart,
  summary: event.summary,
  startsAt: event.startsAt,
  endsAt: event.endsAt,
  allDay: event.allDay,
  recurring: event.recurring,
  url: event.url,
  hidden: event.hidden,
  taskId: event.taskId,
  tombstoned: event.tombstoned,
});

type FeedFetch =
  | {
      readonly kind: "fetched";
      readonly body: string;
      readonly etag: string | null;
      readonly lastModified: string | null;
    }
  | { readonly kind: "unchanged" }
  | { readonly kind: "failed"; readonly errorClass: string };

const readBounded = async (response: Response): Promise<string | undefined> => {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > icsMaxBytes) return undefined;
  if (response.body === null) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > icsMaxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
};

export class CalendarSubscriptionService {
  readonly #key: Buffer;
  readonly #keyId: string;
  readonly #fetch: typeof fetch;
  readonly #lookup: AddressLookup;
  readonly #random: () => number;
  readonly #timeoutMs: number;

  constructor(
    private readonly database: SuiteDatabase,
    keyPath: string,
    options: CalendarSubscriptionServiceOptions = {},
  ) {
    this.#key = loadOrCreateCredentialKey(keyPath);
    this.#keyId = createHash("sha256")
      .update(this.#key)
      .digest("base64url")
      .slice(0, 22);
    this.#fetch = options.fetch ?? fetch;
    this.#lookup = options.lookup ?? defaultLookup;
    this.#random = options.random ?? Math.random;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
  }

  // ── Address handling ─────────────────────────────────────────────────────

  #encrypt(
    ownerId: string,
    subscriptionId: string,
    url: URL,
  ): CalendarSubscriptionUrlCipher {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(aad(ownerId, subscriptionId, this.#keyId));
    const ciphertext = Buffer.concat([
      cipher.update(url.href, "utf8"),
      cipher.final(),
    ]);
    return {
      urlHost: url.host,
      urlKeyId: this.#keyId,
      urlNonce: nonce,
      urlCiphertext: ciphertext,
      urlTag: cipher.getAuthTag(),
    };
  }

  #decrypt(record: CalendarSubscriptionRecord): URL | undefined {
    if (record.urlKeyId !== this.#keyId) return undefined;
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.#key,
        record.urlNonce,
      );
      decipher.setAAD(aad(record.ownerId, record.id, this.#keyId));
      decipher.setAuthTag(Buffer.from(record.urlTag));
      return new URL(
        Buffer.concat([
          decipher.update(Buffer.from(record.urlCiphertext)),
          decipher.final(),
        ]).toString("utf8"),
      );
    } catch {
      return undefined;
    }
  }

  // ── Subscriptions ────────────────────────────────────────────────────────

  list(ownerId: string, now: string): readonly CalendarSubscription[] {
    return this.database.calendarSubscriptions
      .list(ownerId)
      .map((record) => subscriptionResponse(record, now));
  }

  get(
    ownerId: string,
    id: string,
    now: string,
  ): CalendarSubscription | undefined {
    const record = this.database.calendarSubscriptions.get(ownerId, id);
    return record === undefined ? undefined : subscriptionResponse(record, now);
  }

  create(
    ownerId: string,
    input: CalendarSubscriptionCreateRequest,
    now: string,
  ): SubscriptionWriteResult {
    const store = this.database.calendarSubscriptions;
    if (store.count(ownerId) >= calendarSubscriptionMaxCount)
      return { kind: "limit" };
    const checked = checkSubscriptionUrl(input.url);
    if (!checked.ok) return { kind: "invalid_url", reason: checked.reason };
    const settings: CalendarSubscriptionSettings = {
      ...defaultSettings,
      ...Object.fromEntries(
        Object.entries(input).filter(
          ([key, value]) => key !== "url" && value !== undefined,
        ),
      ),
      includePattern: normalizeFilter(input.includePattern),
      excludePattern: normalizeFilter(input.excludePattern),
    };
    if (!filtersUsable(settings)) return { kind: "invalid_filter" };
    const id = randomUUID();
    const record = store.create({
      ...settings,
      ...this.#encrypt(ownerId, id, checked.url),
      id,
      ownerId,
      nextFetchAt: now,
      now,
    });
    return { kind: "ok", subscription: subscriptionResponse(record, now) };
  }

  update(
    ownerId: string,
    id: string,
    expectedRevision: number,
    input: CalendarSubscriptionPatchRequest,
    now: string,
  ): SubscriptionWriteResult {
    const store = this.database.calendarSubscriptions;
    const current = store.get(ownerId, id);
    if (current === undefined) return { kind: "not_found" };
    const { url, ...rest } = input;
    const settings: Partial<CalendarSubscriptionSettings> = {
      ...Object.fromEntries(
        Object.entries(rest).filter(([, value]) => value !== undefined),
      ),
      ...("includePattern" in input
        ? { includePattern: normalizeFilter(input.includePattern) }
        : {}),
      ...("excludePattern" in input
        ? { excludePattern: normalizeFilter(input.excludePattern) }
        : {}),
    };
    if (!filtersUsable({ ...current, ...settings }))
      return { kind: "invalid_filter" };
    let cipher: CalendarSubscriptionUrlCipher | undefined;
    if (url !== undefined) {
      const checked = checkSubscriptionUrl(url);
      if (!checked.ok) return { kind: "invalid_url", reason: checked.reason };
      cipher = this.#encrypt(ownerId, id, checked.url);
    }
    const result = store.update({
      ownerId,
      id,
      expectedRevision,
      settings,
      cipher,
      nextFetchAt:
        cipher !== undefined || settings.enabled === true ? now : undefined,
      now,
    });
    if (result.kind === "not_found") return result;
    if (result.kind === "conflict")
      return {
        kind: "conflict",
        subscription: subscriptionResponse(result.record, now),
      };
    return {
      kind: "ok",
      subscription: subscriptionResponse(result.record, now),
    };
  }

  remove(
    ownerId: string,
    id: string,
    expectedRevision: number,
  ): "deleted" | "conflict" | "not_found" {
    return this.database.calendarSubscriptions.remove(
      ownerId,
      id,
      expectedRevision,
    );
  }

  // ── Fetching ─────────────────────────────────────────────────────────────

  async #fetchFeed(
    initial: URL,
    conditional: {
      readonly etag: string | null;
      readonly lastModified: string | null;
    },
  ): Promise<FeedFetch> {
    let url = initial;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const checked = checkSubscriptionUrl(url.href);
      if (!checked.ok) return { kind: "failed", errorClass: "blocked_address" };
      let addresses: readonly string[];
      try {
        addresses = await this.#lookup(checked.url.hostname);
      } catch {
        return { kind: "failed", errorClass: "dns_failed" };
      }
      if (
        addresses.length === 0 ||
        addresses.some((address) => isBlockedSubscriptionHost(address))
      )
        return { kind: "failed", errorClass: "blocked_address" };
      let response: Response;
      try {
        response = await this.#fetch(checked.url, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(this.#timeoutMs),
          headers: {
            Accept: "text/calendar, text/plain;q=0.5, */*;q=0.1",
            "User-Agent": "Tadooer calendar subscription",
            ...(conditional.etag === null
              ? {}
              : { "If-None-Match": conditional.etag }),
            ...(conditional.lastModified === null
              ? {}
              : { "If-Modified-Since": conditional.lastModified }),
          },
        });
      } catch (error: unknown) {
        const name = error instanceof Error ? error.name : "";
        return {
          kind: "failed",
          errorClass:
            name === "TimeoutError" || name === "AbortError"
              ? "timeout"
              : "network_error",
        };
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (location === null)
          return { kind: "failed", errorClass: "redirect_invalid" };
        try {
          url = new URL(location, checked.url);
        } catch {
          return { kind: "failed", errorClass: "redirect_invalid" };
        }
        continue;
      }
      if (response.status === 304) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: "unchanged" };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return {
          kind: "failed",
          errorClass: `http_${String(response.status)}`,
        };
      }
      const body = await readBounded(response).catch(() => undefined);
      if (body === undefined)
        return { kind: "failed", errorClass: "too_large" };
      return {
        kind: "fetched",
        body,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
      };
    }
    return { kind: "failed", errorClass: "too_many_redirects" };
  }

  /** Fetches one subscription now and records the outcome. */
  async refresh(
    ownerId: string,
    id: string,
    now: string,
  ): Promise<CalendarSubscriptionRefreshResponse | undefined> {
    const store = this.database.calendarSubscriptions;
    const record = store.get(ownerId, id);
    if (record === undefined) return undefined;
    const url = this.#decrypt(record);
    let outcome: CalendarSubscriptionFetchResult;
    let stored: Parameters<typeof store.recordFetch>[0]["outcome"] | undefined;
    if (url === undefined) {
      outcome = { kind: "failed", errorClass: "key_unavailable" };
    } else {
      const fetched = await this.#fetchFeed(url, record);
      if (fetched.kind === "fetched") {
        const nowMs = Date.parse(now);
        const parsed = parseIcalFeed(fetched.body, {
          from: new Date(nowMs - windowBeforeMs).toISOString(),
          to: new Date(nowMs + windowAfterMs).toISOString(),
          timeZone: this.database.getPlanningPreferences(ownerId).timeZone,
        });
        if (parsed.ok) {
          outcome = {
            kind: "fetched",
            events: parsed.events.length,
            counts: parsed.counts,
          };
          stored = {
            kind: "fetched",
            events: parsed.events,
            etag: fetched.etag,
            lastModified: fetched.lastModified,
          };
        } else outcome = { kind: "failed", errorClass: parsed.reason };
      } else outcome = fetched;
    }
    const intervalMinutes =
      outcome.kind === "failed"
        ? Math.min(record.refreshIntervalMinutes, failureRetryMinutes)
        : record.refreshIntervalMinutes;
    const updated = store.recordFetch({
      ownerId,
      id,
      outcome:
        stored ??
        (outcome.kind === "fetched" ? { kind: "unchanged" } : outcome),
      nextFetchAt: nextSubscriptionFetchAt(now, intervalMinutes, this.#random),
      now,
    });
    if (updated === undefined) return undefined;
    return { subscription: subscriptionResponse(updated, now), fetch: outcome };
  }

  /** Fetches every enabled subscription whose next fetch is due. */
  async refreshDue(now: string, limit = 10): Promise<number> {
    let fetched = 0;
    for (const record of this.database.calendarSubscriptions.listDue(
      now,
      limit,
    )) {
      await this.refresh(record.ownerId, record.id, now);
      fetched += 1;
    }
    return fetched;
  }

  // ── Events ───────────────────────────────────────────────────────────────

  /** Visible and hidden occurrences in the window, for the owner's review. */
  events(
    ownerId: string,
    from: string,
    to: string,
  ): readonly CalendarSubscriptionEvent[] {
    return this.database.calendarSubscriptions
      .listEvents(ownerId, from, to, { includeHidden: true })
      .map(subscriptionEventResponse);
  }

  setEventHidden(input: {
    readonly ownerId: string;
    readonly subscriptionId: string;
    readonly uid: string;
    readonly occurrenceStart: string;
    readonly hidden: boolean;
    readonly now: string;
  }): EventStateResult {
    const store = this.database.calendarSubscriptions;
    if (
      store.getEvent(
        input.ownerId,
        input.subscriptionId,
        input.uid,
        input.occurrenceStart,
      ) === undefined
    )
      return { kind: "not_found" };
    store.setEventHidden(input);
    const event = store.getEvent(
      input.ownerId,
      input.subscriptionId,
      input.uid,
      input.occurrenceStart,
    );
    if (event === undefined) return { kind: "not_found" };
    return { kind: "ok", event: subscriptionEventResponse(event) };
  }

  /** Records that auto-import must never create this occurrence. */
  dismissEvent(input: {
    readonly ownerId: string;
    readonly subscriptionId: string;
    readonly uid: string;
    readonly occurrenceStart: string;
    readonly now: string;
  }): EventStateResult {
    const store = this.database.calendarSubscriptions;
    const event = store.getEvent(
      input.ownerId,
      input.subscriptionId,
      input.uid,
      input.occurrenceStart,
    );
    if (event === undefined) return { kind: "not_found" };
    store.recordConversion({ ...input, taskId: null, kind: "dismissed" });
    const updated = store.getEvent(
      input.ownerId,
      input.subscriptionId,
      input.uid,
      input.occurrenceStart,
    );
    if (updated === undefined) return { kind: "not_found" };
    return { kind: "ok", event: subscriptionEventResponse(updated) };
  }

  /**
   * Creates a task from an occurrence, or returns the task an earlier
   * conversion created. The idempotency key is the occurrence identity, so
   * repeating the conversion never duplicates the task.
   */
  convertEvent(input: {
    readonly ownerId: string;
    readonly subscriptionId: string;
    readonly uid: string;
    readonly occurrenceStart: string;
    readonly kind: "manual" | "auto_import";
    readonly now: string;
  }): EventConversionResult {
    const store = this.database.calendarSubscriptions;
    const event = store.getEvent(
      input.ownerId,
      input.subscriptionId,
      input.uid,
      input.occurrenceStart,
    );
    if (event === undefined) return { kind: "not_found" };
    if (event.referenceOnly) return { kind: "reference_only" };
    const existing = store.getConversion(
      input.ownerId,
      input.subscriptionId,
      input.uid,
      input.occurrenceStart,
    );
    if (existing?.taskId != null) {
      const task = this.database.getTask(input.ownerId, existing.taskId, true);
      if (task !== undefined)
        return {
          kind: "ok",
          task: taskResponse(task),
          event: subscriptionEventResponse(event),
          replayed: true,
        };
    }
    const durationMinutes = Math.round(
      (Date.parse(event.endsAt) - Date.parse(event.startsAt)) / 60_000,
    );
    const draft: Parameters<SuiteDatabase["createTaskIdempotently"]>[3] = {
      id: randomUUID(),
      title:
        event.summary.trim() === ""
          ? "Calendar event"
          : event.summary.slice(0, 240),
      notes: [
        `Calendar event from ${event.subscriptionName}.`,
        ...(event.url === null ? [] : [event.url]),
      ].join("\n"),
      status: "open",
      revision: 1,
      createdAt: input.now,
      updatedAt: input.now,
      ...(event.allDay
        ? { plannedDay: event.occurrenceStart.slice(0, 10) }
        : {
            plannedStart: event.startsAt,
            estimateMinutes: Math.max(1, Math.min(720, durationMinutes)),
          }),
    };
    const key = `ical:${input.subscriptionId}:${input.uid}:${input.occurrenceStart}`;
    const created = this.database.createTaskIdempotently(
      input.ownerId,
      key,
      createHash("sha256").update(key).digest("hex"),
      draft,
    );
    if (created.kind === "conflict")
      throw new Error("Calendar conversion key conflicted");
    const task: TaskRecord = created.task;
    store.recordConversion({
      ownerId: input.ownerId,
      subscriptionId: input.subscriptionId,
      uid: input.uid,
      occurrenceStart: input.occurrenceStart,
      taskId: task.id,
      kind: input.kind,
      now: input.now,
    });
    const updated = store.getEvent(
      input.ownerId,
      input.subscriptionId,
      input.uid,
      input.occurrenceStart,
    );
    return {
      kind: "ok",
      task: taskResponse(task),
      event: subscriptionEventResponse(updated ?? event),
      replayed: created.kind === "replayed",
    };
  }

  /**
   * Creates tasks for today's visible, unconverted, undismissed events of
   * the owner's auto-import subscriptions. Tombstones (a conversion or a
   * dismissal) are never re-imported, even after the task was deleted.
   */
  autoImport(ownerId: string, now: string): number {
    const store = this.database.calendarSubscriptions;
    const subscriptions = store
      .listAutoImport()
      .filter((record) => record.ownerId === ownerId);
    if (subscriptions.length === 0) return 0;
    const { timeZone } = this.database.getPlanningPreferences(ownerId);
    const window = zonedDayWindow(now, timeZone);
    let created = 0;
    for (const subscription of subscriptions) {
      if (subscription.hidden) continue;
      for (const event of store.listEvents(ownerId, window.from, window.to, {
        subscriptionId: subscription.id,
      })) {
        if (event.tombstoned || event.hidden) continue;
        const result = this.convertEvent({
          ownerId,
          subscriptionId: subscription.id,
          uid: event.uid,
          occurrenceStart: event.occurrenceStart,
          kind: "auto_import",
          now,
        });
        if (result.kind === "ok" && !result.replayed) created += 1;
      }
    }
    return created;
  }
}
