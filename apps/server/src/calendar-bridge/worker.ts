import type {
  CalendarBridgeHealthSnapshot,
  CalendarBridgeJobKind,
  CalendarBridgeJobRecord,
  SqliteCalendarBridgeWorkerStore,
} from "@suite/persistence";
import type { BridgeLeaseManager } from "./leases.ts";
import type { CalendarBridgeRunOutcome } from "./service.ts";
import { sleep, type SchedulerClock } from "./scheduler-clock.ts";
import type { ProviderThrottle } from "./throttle.ts";

/**
 * Server-owned calendar bridge scheduler (issue #46, ADR 0043). Runs due
 * bridge passes and Google projection syncs for owners with an enabled
 * mapping, with per-process and per-owner concurrency bounds, jittered
 * intervals, exponential backoff, a Google cooldown and bounded shutdown.
 * The pass itself (ADR 0041) is unchanged; this module only decides when
 * to call it and records the outcome.
 */
export interface BridgeWorkerSettings {
  readonly enabled: boolean;
  readonly bridgeIntervalMs: number;
  /** 0 disables projection sync jobs. */
  readonly projectionIntervalMs: number;
  readonly maxBackoffMs: number;
  /** Jobs running at once in this process. */
  readonly concurrency: number;
  /** Jobs running at once for one owner. */
  readonly ownerConcurrency: number;
  readonly shutdownGraceMs: number;
}

export const defaultBridgeWorkerSettings: BridgeWorkerSettings = {
  enabled: true,
  bridgeIntervalMs: 300_000,
  projectionIntervalMs: 900_000,
  maxBackoffMs: 3_600_000,
  concurrency: 2,
  ownerConcurrency: 1,
  shutdownGraceMs: 8_000,
};

export const bridgeWorkerTickMs = 30_000;
export const bridgeRetryBaseMs = 60_000;
export const bridgeIntervalJitter = 0.2;

export type BridgeFailureClass =
  | "rate-limited"
  | "grant-expired"
  | "provider-offline"
  | "ambiguous-write"
  | "configuration"
  | "internal";

export type ProjectionSyncOutcome =
  | { readonly kind: "ok" }
  | {
      readonly kind: "failed";
      readonly failureClass: BridgeFailureClass;
      readonly errorCode: string;
    };

export interface BridgeWorkerDependencies {
  readonly store: SqliteCalendarBridgeWorkerStore;
  readonly leases: BridgeLeaseManager;
  readonly clock: SchedulerClock;
  readonly runBridge: (
    ownerId: string,
    mappingId: string,
    now: Date,
  ) => Promise<CalendarBridgeRunOutcome>;
  readonly runProjection?: (
    ownerId: string,
    now: Date,
  ) => Promise<ProjectionSyncOutcome>;
  readonly throttle?: ProviderThrottle;
  /** Uniform in [0, 1); injectable for deterministic tests. */
  readonly random?: () => number;
}

type JobResult =
  | { readonly kind: "success" }
  | {
      readonly kind: "failure";
      readonly failureClass: BridgeFailureClass;
      readonly errorCode: string;
      /** Highest outbox attempt count, used as a backoff exponent floor. */
      readonly attempts?: number;
    }
  /** Not run (lease held elsewhere, Google cooldown); no failure counted. */
  | { readonly kind: "deferred"; readonly delayMs: number }
  /** The mapping stopped being runnable; the next tick removes the job. */
  | { readonly kind: "gone" };

const grantPattern =
  /unauthorized|forbidden|authentication|authorization|consent|reconnect|not-connected|credential/;
const configurationPattern =
  /calendar-unavailable|unsafe-remote-url|redirected|caldav-unsupported/;

/** Maps a pass or provider reason code to a failure class. */
export const classifyBridgeReason = (reason: string): BridgeFailureClass =>
  grantPattern.test(reason)
    ? "grant-expired"
    : configurationPattern.test(reason)
      ? "configuration"
      : "provider-offline";

/** Unjittered backoff for the n-th consecutive failure (n >= 1). */
export const bridgeBackoffMs = (n: number, maxBackoffMs: number): number =>
  Math.min(maxBackoffMs, bridgeRetryBaseMs * 2 ** Math.max(0, n - 1));

const jobKinds: readonly CalendarBridgeJobKind[] = [
  "bridge",
  "google_projection",
];

export class CalendarBridgeWorker {
  readonly settings: BridgeWorkerSettings;
  readonly #deps: BridgeWorkerDependencies;
  readonly #random: () => number;
  readonly #inFlight = new Map<
    string,
    { readonly ownerId: string; readonly done: Promise<void> }
  >();
  readonly #runs = new Map<string, number>();
  #timer: { cancel(): void } | undefined;
  #started = false;
  #stopping = false;
  #ticking: Promise<void> | undefined;

  constructor(settings: BridgeWorkerSettings, deps: BridgeWorkerDependencies) {
    this.settings = settings;
    this.#deps = deps;
    this.#random = deps.random ?? Math.random;
  }

  /** Starts periodic ticks. The first tick runs one tick interval after start. */
  start(): void {
    if (!this.settings.enabled || this.#started) return;
    this.#started = true;
    this.#schedule();
  }

  #schedule(): void {
    if (this.#stopping) return;
    this.#timer = this.#deps.clock.setTimeout(() => {
      void this.tick().finally(() => {
        this.#schedule();
      });
    }, bridgeWorkerTickMs);
  }

  inFlight(): number {
    return this.#inFlight.size;
  }

  /** Resolves when every job started so far has finished. */
  async idle(): Promise<void> {
    while (this.#inFlight.size > 0)
      await Promise.allSettled(
        [...this.#inFlight.values()].map(({ done }) => done),
      );
  }

  /** One scheduling pass: reconcile jobs, then start due jobs within bounds. */
  tick(): Promise<void> {
    if (this.#ticking !== undefined) return this.#ticking;
    this.#ticking = Promise.resolve()
      .then(() => {
        this.#tick();
      })
      .catch(() => {
        console.error("calendar_bridge.tick_failed");
      })
      .finally(() => {
        this.#ticking = undefined;
      });
    return this.#ticking;
  }

  #tick(): void {
    if (!this.settings.enabled || this.#stopping) return;
    const { store, clock, throttle } = this.#deps;
    const now = clock.now();
    const nowMs = now.getTime();
    const targets = store
      .listJobTargets()
      .filter(
        ({ kind }) =>
          kind === "bridge" ||
          (this.settings.projectionIntervalMs > 0 &&
            this.#deps.runProjection !== undefined),
      );
    // New jobs start within one tick, spread so a restart does not burst.
    store.reconcileJobs(targets, now.toISOString(), () =>
      new Date(
        nowMs + Math.floor(this.#random() * bridgeWorkerTickMs),
      ).toISOString(),
    );
    const horizonMs =
      Math.max(
        this.settings.bridgeIntervalMs,
        this.settings.projectionIntervalMs,
      ) *
        2 +
      this.settings.maxBackoffMs;
    const cooldownMs = throttle?.remainingMs(nowMs) ?? 0;
    for (const job of store.listJobs()) {
      if (this.#inFlight.size >= this.settings.concurrency) break;
      if (this.#inFlight.has(job.key)) continue;
      const dueMs = Date.parse(job.nextDueAt);
      // A due time beyond the horizon means the clock moved back; run it.
      if (dueMs > nowMs && dueMs - nowMs <= horizonMs) continue;
      if (this.#ownerLoad(job.ownerId) >= this.settings.ownerConcurrency)
        continue;
      if (cooldownMs > 0) {
        store.deferJob(
          job.key,
          new Date(
            nowMs +
              cooldownMs +
              Math.floor(this.#random() * bridgeWorkerTickMs),
          ).toISOString(),
          now.toISOString(),
        );
        this.#count(job.kind, "deferred");
        continue;
      }
      this.#start(job);
    }
  }

  #ownerLoad(ownerId: string): number {
    let load = 0;
    for (const job of this.#inFlight.values())
      if (job.ownerId === ownerId) load += 1;
    return load;
  }

  #count(kind: CalendarBridgeJobKind, result: string): void {
    const key = `${kind}|${result}`;
    this.#runs.set(key, (this.#runs.get(key) ?? 0) + 1);
  }

  #start(job: CalendarBridgeJobRecord): void {
    const done = this.#run(job)
      .catch(() => {
        console.error("calendar_bridge.job_failed");
      })
      .finally(() => {
        this.#inFlight.delete(job.key);
      });
    this.#inFlight.set(job.key, { ownerId: job.ownerId, done });
  }

  async #run(job: CalendarBridgeJobRecord): Promise<void> {
    const { store, clock, throttle } = this.#deps;
    const started = clock.now();
    store.markJobStarted(job.key, started.toISOString());
    const throttledBefore = throttle?.events() ?? 0;
    let result: JobResult;
    try {
      result =
        job.kind === "bridge" && job.mappingId !== null
          ? await this.#bridge(job.ownerId, job.mappingId, started)
          : await this.#projection(job.ownerId, started);
    } catch {
      result = {
        kind: "failure",
        failureClass: "internal",
        errorCode: "exception",
      };
    }
    if (
      result.kind === "failure" &&
      throttle !== undefined &&
      throttle.events() > throttledBefore
    )
      result = { ...result, failureClass: "rate-limited" };
    this.#record(job, result);
  }

  async #bridge(
    ownerId: string,
    mappingId: string,
    now: Date,
  ): Promise<JobResult> {
    const { store } = this.#deps;
    const outcome = await this.#deps.runBridge(ownerId, mappingId, now);
    switch (outcome.kind) {
      case "busy":
        return {
          kind: "deferred",
          delayMs:
            bridgeWorkerTickMs +
            Math.floor(this.#random() * bridgeWorkerTickMs),
        };
      case "not-found":
      case "disabled":
        return { kind: "gone" };
      case "blocked":
        return {
          kind: "failure",
          failureClass: classifyBridgeReason(outcome.reason),
          errorCode: outcome.reason,
        };
      case "failed":
        return {
          kind: "failure",
          failureClass: classifyBridgeReason(outcome.reason),
          errorCode: outcome.reason,
          attempts: store.maxUnfinishedAttempts(mappingId),
        };
      case "completed": {
        const attempts = store.maxUnfinishedAttempts(mappingId);
        if (outcome.counts.uncertain > 0)
          return {
            kind: "failure",
            failureClass: "ambiguous-write",
            errorCode: "uncertain-operation",
            attempts,
          };
        const refused = store.refusedOperationError(mappingId);
        return refused === undefined
          ? { kind: "success" }
          : {
              kind: "failure",
              failureClass: classifyBridgeReason(refused),
              errorCode: refused,
              attempts,
            };
      }
    }
  }

  async #projection(ownerId: string, now: Date): Promise<JobResult> {
    const runProjection = this.#deps.runProjection;
    if (runProjection === undefined) return { kind: "gone" };
    const leased = await this.#deps.leases.withLease(
      `google-projection:${ownerId}`,
      now,
      () => runProjection(ownerId, now),
    );
    if (!leased.acquired)
      return {
        kind: "deferred",
        delayMs:
          bridgeWorkerTickMs + Math.floor(this.#random() * bridgeWorkerTickMs),
      };
    return leased.value.kind === "ok"
      ? { kind: "success" }
      : {
          kind: "failure",
          failureClass: leased.value.failureClass,
          errorCode: leased.value.errorCode,
        };
  }

  #record(job: CalendarBridgeJobRecord, result: JobResult): void {
    const { store, clock, throttle } = this.#deps;
    const finished = clock.now();
    const finishedMs = finished.getTime();
    const iso = finished.toISOString();
    const at = (delayMs: number) =>
      new Date(finishedMs + Math.max(0, Math.round(delayMs))).toISOString();
    this.#count(
      job.kind,
      result.kind === "failure" ? result.failureClass : result.kind,
    );
    switch (result.kind) {
      case "success": {
        const interval =
          job.kind === "bridge"
            ? this.settings.bridgeIntervalMs
            : this.settings.projectionIntervalMs;
        const jitter = (this.#random() * 2 - 1) * bridgeIntervalJitter;
        store.recordJobSuccess(job.key, at(interval * (1 + jitter)), iso);
        return;
      }
      case "failure": {
        const n = Math.max(job.consecutiveFailures + 1, result.attempts ?? 0);
        const backoff = bridgeBackoffMs(n, this.settings.maxBackoffMs);
        // Randomized over the upper half so retries of many jobs spread out.
        let delay = backoff / 2 + (this.#random() * backoff) / 2;
        if (result.failureClass === "rate-limited" && throttle !== undefined)
          delay = Math.max(delay, throttle.remainingMs(finishedMs));
        store.recordJobFailure({
          key: job.key,
          nextDueAt: at(delay),
          failureClass: result.failureClass,
          errorCode: result.errorCode,
          now: iso,
        });
        return;
      }
      case "deferred":
        store.deferJob(job.key, at(result.delayMs), iso);
        return;
      case "gone":
        store.deferJob(job.key, at(bridgeWorkerTickMs), iso);
        return;
    }
  }

  /**
   * Stops scheduling and waits up to the grace period for in-flight jobs.
   * A job still running afterwards is left at its last durable checkpoint
   * (ADR 0041) and its lease expires.
   */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#timer?.cancel();
    if (this.#inFlight.size === 0) return;
    const timedOut = Symbol("timed-out");
    const result = await Promise.race([
      this.idle(),
      sleep(this.#deps.clock, this.settings.shutdownGraceMs).then(
        () => timedOut,
      ),
    ]);
    if (result === timedOut) console.error("calendar_bridge.shutdown_timeout");
  }

  /** `disabled`, `idle` (no jobs), `ok` or `degraded`, for readiness. */
  healthState(
    snapshot: CalendarBridgeHealthSnapshot,
  ): "disabled" | "idle" | "ok" | "degraded" {
    if (!this.settings.enabled) return "disabled";
    if (snapshot.jobs.length === 0) return "idle";
    return snapshot.jobs.some(({ failing }) => failing) ||
      snapshot.stuckOperations > 0
      ? "degraded"
      : "ok";
  }

  runCounts(): ReadonlyMap<string, number> {
    return this.#runs;
  }
}

/**
 * Content-free Prometheus lines (ADR 0043): aggregates only, no mapping,
 * calendar or event identifiers.
 */
export const calendarBridgeMetricLines = (input: {
  readonly snapshot: CalendarBridgeHealthSnapshot;
  readonly nowMs: number;
  readonly worker: CalendarBridgeWorker | undefined;
  readonly throttle: ProviderThrottle | undefined;
}): readonly string[] => {
  const { snapshot, nowMs, worker } = input;
  const lines: string[] = [
    "# HELP suite_calendar_bridge_worker_enabled Whether the calendar bridge worker runs in this process.",
    "# TYPE suite_calendar_bridge_worker_enabled gauge",
    `suite_calendar_bridge_worker_enabled ${worker?.settings.enabled === true ? "1" : "0"}`,
    "# HELP suite_calendar_bridge_mappings_enabled Enabled live bridge mappings.",
    "# TYPE suite_calendar_bridge_mappings_enabled gauge",
    `suite_calendar_bridge_mappings_enabled ${String(snapshot.enabledMappings)}`,
    "# HELP suite_calendar_bridge_jobs Scheduled bridge worker jobs.",
    "# TYPE suite_calendar_bridge_jobs gauge",
  ];
  for (const kind of jobKinds)
    lines.push(
      `suite_calendar_bridge_jobs{kind="${kind}"} ${String(snapshot.jobs.filter((job) => job.kind === kind).length)}`,
    );
  lines.push(
    "# HELP suite_calendar_bridge_jobs_failing Jobs whose last run failed, by failure class.",
    "# TYPE suite_calendar_bridge_jobs_failing gauge",
  );
  const failing = new Map<string, number>();
  for (const job of snapshot.jobs)
    if (job.failing) {
      const key = `kind="${job.kind}",class="${job.lastFailureClass ?? "internal"}"`;
      failing.set(key, (failing.get(key) ?? 0) + 1);
    }
  for (const [labels, count] of [...failing.entries()].sort())
    lines.push(
      `suite_calendar_bridge_jobs_failing{${labels}} ${String(count)}`,
    );
  lines.push(
    "# HELP suite_calendar_bridge_last_success_age_seconds Age of the stalest job's last success.",
    "# TYPE suite_calendar_bridge_last_success_age_seconds gauge",
  );
  for (const kind of jobKinds) {
    const successes = snapshot.jobs
      .filter((job) => job.kind === kind && job.lastSuccessAt !== null)
      .map((job) => Date.parse(job.lastSuccessAt ?? ""));
    if (successes.length > 0)
      lines.push(
        `suite_calendar_bridge_last_success_age_seconds{kind="${kind}"} ${String(Math.max(0, Math.floor((nowMs - Math.min(...successes)) / 1000)))}`,
      );
  }
  lines.push(
    "# HELP suite_calendar_bridge_never_succeeded_jobs Jobs without a successful run yet.",
    "# TYPE suite_calendar_bridge_never_succeeded_jobs gauge",
  );
  for (const kind of jobKinds)
    lines.push(
      `suite_calendar_bridge_never_succeeded_jobs{kind="${kind}"} ${String(snapshot.jobs.filter((job) => job.kind === kind && job.lastSuccessAt === null).length)}`,
    );
  lines.push(
    "# HELP suite_calendar_bridge_backlog_operations Unfinished bridge outbox operations by state.",
    "# TYPE suite_calendar_bridge_backlog_operations gauge",
    `suite_calendar_bridge_backlog_operations{state="pending"} ${String(snapshot.backlog.pending)}`,
    `suite_calendar_bridge_backlog_operations{state="dispatched"} ${String(snapshot.backlog.dispatched)}`,
    `suite_calendar_bridge_backlog_operations{state="uncertain"} ${String(snapshot.backlog.uncertain)}`,
    "# HELP suite_calendar_bridge_stuck_operations Unfinished operations with five or more attempts.",
    "# TYPE suite_calendar_bridge_stuck_operations gauge",
    `suite_calendar_bridge_stuck_operations ${String(snapshot.stuckOperations)}`,
    "# HELP suite_calendar_bridge_open_conflicts Open bridge conflicts awaiting review.",
    "# TYPE suite_calendar_bridge_open_conflicts gauge",
    `suite_calendar_bridge_open_conflicts ${String(snapshot.openConflicts)}`,
    "# HELP suite_calendar_bridge_in_flight Bridge worker jobs running in this process.",
    "# TYPE suite_calendar_bridge_in_flight gauge",
    `suite_calendar_bridge_in_flight ${String(worker?.inFlight() ?? 0)}`,
    "# HELP suite_calendar_bridge_google_cooldown_seconds Remaining Google rate-limit cooldown.",
    "# TYPE suite_calendar_bridge_google_cooldown_seconds gauge",
    `suite_calendar_bridge_google_cooldown_seconds ${String(Math.ceil((input.throttle?.remainingMs(nowMs) ?? 0) / 1000))}`,
    "# HELP suite_calendar_bridge_runs_total Bridge worker job results in this process.",
    "# TYPE suite_calendar_bridge_runs_total counter",
  );
  for (const [key, count] of [
    ...(worker?.runCounts() ?? new Map<string, number>()).entries(),
  ].sort()) {
    const [kind, result] = key.split("|");
    lines.push(
      `suite_calendar_bridge_runs_total{kind="${kind ?? ""}",result="${result ?? ""}"} ${String(count)}`,
    );
  }
  return lines;
};
