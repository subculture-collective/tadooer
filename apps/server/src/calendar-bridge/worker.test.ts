import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SuiteDatabase } from "@suite/persistence";
import { withTemporaryDirectory } from "@suite/test-support";
import { BridgeLeaseManager } from "./leases.ts";
import { ManualClock, settle } from "./manual-clock.ts";
import type { CalendarBridgeRunOutcome } from "./service.ts";
import { ProviderThrottle, parseRetryAfter } from "./throttle.ts";
import {
  CalendarBridgeWorker,
  bridgeBackoffMs,
  calendarBridgeMetricLines,
  classifyBridgeReason,
  defaultBridgeWorkerSettings,
  type BridgeWorkerSettings,
  type ProjectionSyncOutcome,
} from "./worker.ts";

// Background bridge worker (issue #46, ADR 0043) against a real SQLite file,
// a manual clock and fake pass runners. No network.
const start = "2026-09-29T12:00:00.000Z";
const ownerA = "11111111-1111-4111-8111-111111111111";
const ownerB = "22222222-2222-4222-8222-222222222222";
const zeroCounts = {
  settled: 0,
  enqueued: 0,
  applied: 0,
  uncertain: 0,
  failed: 0,
  conflicts: 0,
  blocked: 0,
  excluded: 0,
};
const completed: CalendarBridgeRunOutcome = {
  kind: "completed",
  counts: zeroCounts,
};

const addOwner = (database: SuiteDatabase, ownerId: string): void => {
  database.createOwner({
    id: ownerId,
    username: ownerId.slice(0, 8),
    displayName: "Owner",
    passwordHash: "hash",
    createdAt: start,
  });
};

let calendarSequence = 0;
/** Creates one enabled mapping between two new collections. */
const addMapping = (database: SuiteDatabase, ownerId: string): string => {
  calendarSequence += 1;
  const suffix = String(calendarSequence);
  const google = database.ensureCalendarProvider(ownerId, "google", "g", start);
  const baikal = database.ensureCalendarProvider(ownerId, "baikal", "b", start);
  const googleId =
    database.putCalendarCollections(
      google.id,
      [
        {
          href: `cal${suffix}@example.test`,
          displayName: "Google",
          supportsEvents: true,
          supportsTodos: false,
        },
      ],
      start,
    )[0]?.id ?? "";
  const baikalId =
    database.putCalendarCollections(
      baikal.id,
      [
        {
          href: `/dav.php/calendars/alice/c${suffix}/`,
          displayName: "Baikal",
          supportsEvents: true,
          supportsTodos: false,
        },
      ],
      start,
    )[0]?.id ?? "";
  const id = `33333333-3333-4333-8333-${suffix.padStart(12, "0")}`;
  const created = database.calendarBridge.createMapping({
    id,
    ownerId,
    googleCalendarId: googleId,
    baikalCalendarId: baikalId,
    direction: "two_way",
    initialSync: "copy_existing",
    now: start,
  });
  if (created.kind !== "created") throw new Error(created.kind);
  return id;
};

/** A controllable pass: resolves when the test says so. */
const gate = <T>() => {
  let release: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

interface Rig {
  readonly database: SuiteDatabase;
  readonly clock: ManualClock;
  readonly leases: BridgeLeaseManager;
  readonly throttle: ProviderThrottle;
  readonly worker: CalendarBridgeWorker;
  readonly calls: string[];
}

const rig = (
  path: string,
  options: {
    readonly clock?: ManualClock;
    readonly settings?: Partial<BridgeWorkerSettings>;
    readonly runBridge?: (
      ownerId: string,
      mappingId: string,
      now: Date,
      leases: BridgeLeaseManager,
    ) => Promise<CalendarBridgeRunOutcome>;
    readonly runProjection?: (
      ownerId: string,
      now: Date,
    ) => Promise<ProjectionSyncOutcome>;
    readonly holder?: string;
    readonly random?: () => number;
  } = {},
): Rig => {
  const database = SuiteDatabase.open(path);
  const clock = options.clock ?? new ManualClock(start);
  const leases = new BridgeLeaseManager(database.calendarBridgeWorker, {
    clock,
    holder: options.holder ?? "process-a",
  });
  const throttle = new ProviderThrottle(clock);
  const calls: string[] = [];
  const worker = new CalendarBridgeWorker(
    { ...defaultBridgeWorkerSettings, ...options.settings },
    {
      store: database.calendarBridgeWorker,
      leases,
      clock,
      throttle,
      random: options.random ?? (() => 0.5),
      runBridge: async (ownerId, mappingId, now) => {
        calls.push(`bridge:${mappingId}`);
        return options.runBridge === undefined
          ? completed
          : options.runBridge(ownerId, mappingId, now, leases);
      },
      ...(options.runProjection === undefined
        ? {}
        : {
            runProjection: async (ownerId: string, now: Date) => {
              calls.push(`projection:${ownerId}`);
              return (
                options.runProjection?.(ownerId, now) ??
                Promise.resolve({ kind: "ok" as const })
              );
            },
          }),
    },
  );
  return { database, clock, leases, throttle, worker, calls };
};

/** Mirrors CalendarBridgeService.runOnce: the pass runs under the lease. */
const leasedPass =
  (work: () => Promise<CalendarBridgeRunOutcome>) =>
  async (
    _ownerId: string,
    mappingId: string,
    now: Date,
    leases: BridgeLeaseManager,
  ): Promise<CalendarBridgeRunOutcome> => {
    const leased = await leases.withLease(`bridge:${mappingId}`, now, work);
    return leased.acquired ? leased.value : { kind: "busy" };
  };

const tick = async (worker: CalendarBridgeWorker): Promise<void> => {
  await worker.tick();
  await worker.idle();
  await settle();
};

const job = (database: SuiteDatabase, key: string) => {
  const found = database.calendarBridgeWorker.getJob(key);
  if (found === undefined) throw new Error(`missing job ${key}`);
  return found;
};

const secondsAfter = (from: string, to: string): number =>
  (Date.parse(to) - Date.parse(from)) / 1000;

describe("calendar bridge worker", () => {
  it("stays idle without an enabled mapping and when switched off", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "suite.sqlite");
      const off = rig(path, { settings: { enabled: false } });
      addOwner(off.database, ownerA);
      addMapping(off.database, ownerA);
      await tick(off.worker);
      off.worker.start();
      expect(off.clock.pendingTimers()).toBe(0);
      expect(off.calls).toEqual([]);
      expect(off.database.calendarBridgeWorker.listJobs()).toEqual([]);
      expect(
        off.worker.healthState(off.database.calendarBridgeWorker.health()),
      ).toBe("disabled");
      off.database.close();

      const empty = rig(join(directory, "empty.sqlite"));
      addOwner(empty.database, ownerA);
      await tick(empty.worker);
      expect(empty.calls).toEqual([]);
      expect(
        empty.worker.healthState(empty.database.calendarBridgeWorker.health()),
      ).toBe("idle");
      empty.database.close();
    });
  });

  it("runs due passes on a jittered interval without a browser", async () => {
    await withTemporaryDirectory(async (directory) => {
      const r = rig(join(directory, "suite.sqlite"), { random: () => 0 });
      addOwner(r.database, ownerA);
      const mappingId = addMapping(r.database, ownerA);
      r.worker.start();
      // The first tick runs one tick interval after start.
      await r.clock.advance(29_000);
      expect(r.calls).toEqual([]);
      await r.clock.advance(1_000);
      await r.worker.idle();
      expect(r.calls).toEqual([`bridge:${mappingId}`]);
      const first = job(r.database, `bridge:${mappingId}`);
      expect(first.lastSuccessAt).toBe("2026-09-29T12:00:30.000Z");
      // random 0 gives the lower jitter bound: 300 s × 0.8.
      expect(secondsAfter(first.lastSuccessAt ?? "", first.nextDueAt)).toBe(
        240,
      );
      await r.clock.advance(200_000);
      expect(r.calls).toHaveLength(1);
      await r.clock.advance(60_000);
      await r.worker.idle();
      expect(r.calls).toHaveLength(2);
      expect(
        r.worker.healthState(r.database.calendarBridgeWorker.health()),
      ).toBe("ok");
      await r.worker.stop();
      expect(r.clock.pendingTimers()).toBe(0);
      r.database.close();
    });
  });

  it("backs off exponentially from failures and outbox attempts", async () => {
    await withTemporaryDirectory(async (directory) => {
      const outcomes: CalendarBridgeRunOutcome[] = [];
      const r = rig(join(directory, "suite.sqlite"), {
        random: () => 0,
        runBridge: () =>
          Promise.resolve(
            outcomes.shift() ?? {
              kind: "failed",
              reason: "google-unavailable",
              counts: zeroCounts,
            },
          ),
      });
      addOwner(r.database, ownerA);
      const mappingId = addMapping(r.database, ownerA);
      const key = `bridge:${mappingId}`;
      const delays: number[] = [];
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const before = r.database.calendarBridgeWorker.getJob(key)?.nextDueAt;
        if (before !== undefined)
          r.clock.set(Math.max(Date.parse(before), r.clock.now().getTime()));
        await tick(r.worker);
        const after = job(r.database, key);
        delays.push(secondsAfter(after.lastFailureAt ?? "", after.nextDueAt));
      }
      // random 0 selects the lower half: 30, 60, 120, ... capped at 3600 / 2.
      expect(delays).toEqual([30, 60, 120, 240, 480, 960, 1800, 1800]);
      const failing = job(r.database, key);
      expect(failing).toMatchObject({
        consecutiveFailures: 8,
        lastFailureClass: "provider-offline",
        lastErrorCode: "google-unavailable",
      });
      expect(
        r.worker.healthState(r.database.calendarBridgeWorker.health()),
      ).toBe("degraded");

      // Success resets the count.
      outcomes.push(completed);
      r.clock.set(failing.nextDueAt);
      await tick(r.worker);
      expect(job(r.database, key)).toMatchObject({
        consecutiveFailures: 0,
        lastFailureClass: null,
      });

      // A provider-refused operation with 4 attempts starts the backoff at 2^3.
      const store = r.database.calendarBridge;
      const linkNow = r.clock.now().toISOString();
      const operation = store.insertLinkWithCreate(
        {
          id: "44444444-4444-4444-8444-444444444444",
          mappingId,
          ownerId: ownerA,
          origin: "google",
          googleEventId: "evt1",
          googleIcalUid: null,
          baikalHref: null,
          baikalUid: null,
          google: {
            kind: "unknown",
            revision: null,
            digest: null,
            snapshot: null,
          },
          baikal: {
            kind: "unknown",
            revision: null,
            digest: null,
            snapshot: null,
          },
          status: "pending",
          statusReason: null,
          now: linkNow,
        },
        {
          id: "55555555-5555-4555-8555-555555555555",
          target: "baikal",
          action: "create",
          targetNativeId: "/dav.php/calendars/alice/x.ics",
          targetUid: null,
          expectedRevision: null,
          sourceSide: "google",
          sourceRevision: "e1",
          payload: "{}",
          payloadDigest: "d1",
          reason: "create",
        },
        1,
      );
      for (let attempt = 0; attempt < 4; attempt += 1) {
        store.markDispatched(operation.id, linkNow);
        store.returnToPending(
          operation.id,
          "baikal-authentication-required",
          linkNow,
        );
      }
      outcomes.push(completed);
      r.clock.set(job(r.database, key).nextDueAt);
      await tick(r.worker);
      const refused = job(r.database, key);
      expect(refused).toMatchObject({
        consecutiveFailures: 1,
        lastFailureClass: "grant-expired",
        lastErrorCode: "baikal-authentication-required",
      });
      expect(secondsAfter(refused.lastFailureAt ?? "", refused.nextDueAt)).toBe(
        240,
      );
      r.database.close();
    });
  });

  it("classifies failures and honours Google Retry-After", async () => {
    expect(classifyBridgeReason("google-reconnect-required")).toBe(
      "grant-expired",
    );
    expect(classifyBridgeReason("baikal-authorization-denied")).toBe(
      "grant-expired",
    );
    expect(classifyBridgeReason("calendar-unavailable")).toBe("configuration");
    expect(classifyBridgeReason("google-calendar-not-writable")).toBe(
      "configuration",
    );
    expect(classifyBridgeReason("baikal-transport-failed")).toBe(
      "provider-offline",
    );
    expect(bridgeBackoffMs(1, 3_600_000)).toBe(60_000);
    expect(bridgeBackoffMs(20, 3_600_000)).toBe(3_600_000);
    const nowMs = Date.parse(start);
    expect(parseRetryAfter("120", nowMs)).toBe(120_000);
    expect(parseRetryAfter("Tue, 29 Sep 2026 12:02:00 GMT", nowMs)).toBe(
      120_000,
    );
    expect(parseRetryAfter("soon", nowMs)).toBeUndefined();
    expect(parseRetryAfter(null, nowMs)).toBeUndefined();

    const clock = new ManualClock(start);
    const throttle = new ProviderThrottle(clock);
    const responses = [
      new Response("{}", { status: 429, headers: { "Retry-After": "90" } }),
      new Response('{"error":{"errors":[{"reason":"forbidden"}]}}', {
        status: 403,
      }),
      new Response(
        '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}',
        { status: 403 },
      ),
    ];
    const wrapped = throttle.wrap(() =>
      Promise.resolve(responses.shift() ?? new Response("{}")),
    );
    const first = await wrapped("https://www.googleapis.com/x");
    expect(first.status).toBe(429);
    expect(throttle.remainingMs(nowMs)).toBe(90_000);
    await wrapped("https://www.googleapis.com/x");
    expect(throttle.events()).toBe(1);
    const limited = await wrapped("https://www.googleapis.com/x");
    // The caller can still read the body the throttle inspected.
    expect(await limited.text()).toContain("userRateLimitExceeded");
    expect(throttle.events()).toBe(2);
    expect(throttle.remainingMs(nowMs)).toBe(90_000);

    await withTemporaryDirectory(async (directory) => {
      const r = rig(join(directory, "suite.sqlite"), { random: () => 0 });
      addOwner(r.database, ownerA);
      r.database.putGoogleConnector({
        id: "66666666-6666-4666-8666-666666666666",
        ownerId: ownerA,
        credentialKeyId: "key",
        credentialNonce: new Uint8Array(12),
        credentialCiphertext: new Uint8Array(1),
        credentialTag: new Uint8Array(16),
        grantedScopes: [],
        accountLabel: null,
        state: "connected",
        createdAt: start,
        updatedAt: start,
        revokedAt: null,
      });
      const mappingId = addMapping(r.database, ownerA);
      let limitedOnce = false;
      const runBridge = (): Promise<CalendarBridgeRunOutcome> => {
        if (!limitedOnce) {
          limitedOnce = true;
          r.throttle.note(parseRetryAfter("600", r.clock.now().getTime()));
        }
        return Promise.resolve({
          kind: "failed",
          reason: "google-forbidden",
          counts: zeroCounts,
        });
      };
      const limitedRig = new CalendarBridgeWorker(
        { ...defaultBridgeWorkerSettings, concurrency: 1 },
        {
          store: r.database.calendarBridgeWorker,
          leases: r.leases,
          clock: r.clock,
          throttle: r.throttle,
          random: () => 0,
          runBridge,
          runProjection: () =>
            Promise.resolve({ kind: "ok" } satisfies ProjectionSyncOutcome),
        },
      );
      await tick(limitedRig);
      const bridge = job(r.database, `bridge:${mappingId}`);
      expect(bridge.lastFailureClass).toBe("rate-limited");
      // The cooldown floor (600 s) beats the first backoff step (30 s).
      expect(secondsAfter(bridge.lastFailureAt ?? "", bridge.nextDueAt)).toBe(
        600,
      );
      // The projection job is deferred past the cooldown, not failed.
      await tick(limitedRig);
      const projection = job(r.database, `google-projection:${ownerA}`);
      expect(projection.consecutiveFailures).toBe(0);
      expect(projection.lastStartedAt).toBeNull();
      expect(Date.parse(projection.nextDueAt)).toBeGreaterThanOrEqual(
        Date.parse(start) + 600_000,
      );
      r.database.close();
    });
  });

  it("bounds concurrency per owner and per process", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "suite.sqlite");
      const gates = new Map<string, ReturnType<typeof gate<undefined>>>();
      const runBridge = async (_ownerId: string, mappingId: string) => {
        const pending = gate<undefined>();
        gates.set(mappingId, pending);
        await pending.promise;
        return completed;
      };
      const r = rig(path, { random: () => 0, runBridge });
      addOwner(r.database, ownerA);
      const m1 = addMapping(r.database, ownerA);
      const m2 = addMapping(r.database, ownerA);
      const m3 = addMapping(r.database, ownerA);
      // A disabled owner's mappings never get jobs (one active owner per
      // installation; the row is inserted directly).
      const raw = new DatabaseSync(path);
      raw
        .prepare(
          `INSERT INTO owner_accounts
             (id, username, display_name, password_hash, created_at, disabled_at)
           VALUES (?, 'former', 'Former', 'hash', ?, ?)`,
        )
        .run(ownerB, start, start);
      raw.close();
      addMapping(r.database, ownerB);

      // Default: one job per owner.
      await r.worker.tick();
      await settle();
      expect(r.calls).toEqual([`bridge:${m1}`]);
      await r.worker.tick();
      await settle();
      expect(r.calls).toHaveLength(1);
      gates.get(m1)?.release(undefined);
      await settle();
      await r.worker.tick();
      await settle();
      expect(r.calls).toEqual([`bridge:${m1}`, `bridge:${m2}`]);
      gates.get(m2)?.release(undefined);
      await r.worker.idle();

      // Per-process bound: owner limit 3, process limit 2.
      const wide = new CalendarBridgeWorker(
        { ...defaultBridgeWorkerSettings, concurrency: 2, ownerConcurrency: 3 },
        {
          store: r.database.calendarBridgeWorker,
          leases: r.leases,
          clock: r.clock,
          random: () => 0,
          runBridge,
        },
      );
      r.clock.set(r.clock.now().getTime() + 3_600_000);
      gates.clear();
      await wide.tick();
      await settle();
      expect(wide.inFlight()).toBe(2);
      expect([...gates.keys()]).toEqual([m3, m1]);
      expect(
        r.database.calendarBridgeWorker
          .listJobs()
          .every(({ ownerId }) => ownerId === ownerA),
      ).toBe(true);
      for (const pending of gates.values()) pending.release(undefined);
      await wide.idle();
      r.database.close();
    });
  });

  it("never runs one mapping in two processes at once", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "suite.sqlite");
      const clock = new ManualClock(start);
      const pass = gate<CalendarBridgeRunOutcome>();
      let running = 0;
      let overlap = false;
      const work = async (): Promise<CalendarBridgeRunOutcome> => {
        running += 1;
        if (running > 1) overlap = true;
        const outcome = await pass.promise;
        running -= 1;
        return outcome;
      };
      const a = rig(path, {
        clock,
        holder: "process-a",
        random: () => 0,
        runBridge: leasedPass(work),
      });
      addOwner(a.database, ownerA);
      const mappingId = addMapping(a.database, ownerA);
      const key = `bridge:${mappingId}`;
      const b = rig(path, {
        clock,
        holder: "process-b",
        random: () => 0,
        runBridge: leasedPass(work),
      });
      await a.worker.tick();
      await settle();
      expect(a.worker.inFlight()).toBe(1);
      await tick(b.worker);
      // B found the lease held: deferred, not a failure.
      expect(b.calls).toEqual([key]);
      expect(job(b.database, key)).toMatchObject({ consecutiveFailures: 0 });
      expect(b.worker.runCounts().get("bridge|deferred")).toBe(1);
      // The lease is renewed while the pass runs past its original expiry.
      await clock.advance(25 * 60_000);
      expect(
        Date.parse(
          b.database.calendarBridgeWorker.getLease(key)?.expiresAt ?? "",
        ),
      ).toBeGreaterThan(clock.now().getTime());
      await tick(b.worker);
      expect(b.calls).toHaveLength(2);
      expect(running).toBe(1);
      pass.release(completed);
      await a.worker.idle();
      expect(overlap).toBe(false);
      expect(a.database.calendarBridgeWorker.getLease(key)).toBeUndefined();

      // A crashed holder's lease blocks until it expires, then B runs.
      a.database.calendarBridgeWorker.acquireLease({
        key,
        holder: "crashed",
        now: clock.now().toISOString(),
        expiresAt: new Date(clock.now().getTime() + 600_000).toISOString(),
      });
      clock.set(Date.parse(job(b.database, key).nextDueAt));
      await tick(b.worker);
      expect(b.worker.runCounts().get("bridge|deferred")).toBe(3);
      clock.set(clock.now().getTime() + 600_000);
      await tick(b.worker);
      expect(b.worker.runCounts().get("bridge|success")).toBe(1);
      a.database.close();
      b.database.close();
    });
  });

  it("lets an in-flight pass finish on shutdown, bounded by the grace period", async () => {
    await withTemporaryDirectory(async (directory) => {
      const pass = gate<CalendarBridgeRunOutcome>();
      const r = rig(join(directory, "suite.sqlite"), {
        random: () => 0,
        runBridge: leasedPass(() => pass.promise),
      });
      addOwner(r.database, ownerA);
      const mappingId = addMapping(r.database, ownerA);
      const key = `bridge:${mappingId}`;
      r.worker.start();
      await r.clock.advance(30_000);
      expect(r.worker.inFlight()).toBe(1);
      let stopped = false;
      const stopping = r.worker.stop().then(() => {
        stopped = true;
      });
      await settle();
      expect(stopped).toBe(false);
      // No new ticks after stop.
      await r.worker.tick();
      expect(r.calls).toHaveLength(1);
      pass.release(completed);
      await stopping;
      expect(job(r.database, key).lastSuccessAt).not.toBeNull();
      expect(r.database.calendarBridgeWorker.getLease(key)).toBeUndefined();
      r.database.close();

      // A pass that outlives the grace period keeps its lease and checkpoint.
      const stuck = gate<CalendarBridgeRunOutcome>();
      const s = rig(join(directory, "stuck.sqlite"), {
        random: () => 0,
        runBridge: leasedPass(() => stuck.promise),
      });
      addOwner(s.database, ownerA);
      const stuckId = addMapping(s.database, ownerA);
      await s.worker.tick();
      await settle();
      let done = false;
      const stopStuck = s.worker.stop().then(() => {
        done = true;
      });
      await s.clock.advance(7_000);
      expect(done).toBe(false);
      await s.clock.advance(1_000);
      await stopStuck;
      expect(done).toBe(true);
      expect(
        s.database.calendarBridgeWorker.getLease(`bridge:${stuckId}`),
      ).toMatchObject({ holder: "process-a" });
      stuck.release(completed);
      await s.worker.idle();
      s.database.close();
    });
  });

  it("resumes the durable schedule after a restart and a clock change", async () => {
    await withTemporaryDirectory(async (directory) => {
      const path = join(directory, "suite.sqlite");
      const first = rig(path, { random: () => 0 });
      addOwner(first.database, ownerA);
      const mappingId = addMapping(first.database, ownerA);
      const key = `bridge:${mappingId}`;
      await tick(first.worker);
      const scheduled = job(first.database, key);
      expect(
        secondsAfter(scheduled.lastSuccessAt ?? "", scheduled.nextDueAt),
      ).toBe(240);
      first.database.close();

      // Restart before the job is due: nothing runs early.
      const clock = new ManualClock(Date.parse(start) + 60_000);
      const second = rig(path, { clock, holder: "process-b" });
      await tick(second.worker);
      expect(second.calls).toEqual([]);
      // Six hours of downtime: the overdue job runs once on the first tick.
      clock.set(Date.parse(start) + 6 * 3_600_000);
      await tick(second.worker);
      expect(second.calls).toEqual([key]);
      await tick(second.worker);
      expect(second.calls).toHaveLength(1);

      // The clock moves back a day: a due time beyond the horizon runs now.
      clock.set(Date.parse(start) - 86_400_000);
      await tick(second.worker);
      expect(second.calls).toHaveLength(2);
      expect(
        Date.parse(job(second.database, key).nextDueAt) - clock.now().getTime(),
      ).toBe(300_000);

      // Disabling the mapping removes its job on the next tick.
      const mapping = second.database.calendarBridge.getMapping(
        ownerA,
        mappingId,
      );
      second.database.calendarBridge.setMappingEnabled({
        ownerId: ownerA,
        mappingId,
        expectedRevision: mapping?.revision ?? 0,
        enabled: false,
        now: clock.now().toISOString(),
      });
      await tick(second.worker);
      expect(second.database.calendarBridgeWorker.listJobs()).toEqual([]);
      second.database.close();
    });
  });

  it("isolates a poisoned mapping and exports content-free metrics", async () => {
    await withTemporaryDirectory(async (directory) => {
      let poisoned = "";
      const r = rig(join(directory, "suite.sqlite"), {
        random: () => 0,
        settings: { ownerConcurrency: 2 },
        runBridge: (_ownerId, mappingId) =>
          mappingId === poisoned
            ? Promise.reject(new Error("secret-token-in-message"))
            : Promise.resolve(completed),
      });
      addOwner(r.database, ownerA);
      poisoned = addMapping(r.database, ownerA);
      const healthy = addMapping(r.database, ownerA);
      await tick(r.worker);
      expect(job(r.database, `bridge:${poisoned}`)).toMatchObject({
        lastFailureClass: "internal",
        lastErrorCode: "exception",
      });
      expect(job(r.database, `bridge:${healthy}`).lastSuccessAt).not.toBeNull();
      const lines = calendarBridgeMetricLines({
        snapshot: r.database.calendarBridgeWorker.health(),
        nowMs: r.clock.now().getTime() + 5_000,
        worker: r.worker,
        throttle: r.throttle,
      }).join("\n");
      expect(lines).toContain("suite_calendar_bridge_worker_enabled 1");
      expect(lines).toContain('suite_calendar_bridge_jobs{kind="bridge"} 2');
      expect(lines).toContain(
        'suite_calendar_bridge_jobs_failing{kind="bridge",class="internal"} 1',
      );
      expect(lines).toContain(
        'suite_calendar_bridge_last_success_age_seconds{kind="bridge"} 5',
      );
      expect(lines).toContain(
        'suite_calendar_bridge_backlog_operations{state="pending"} 0',
      );
      expect(lines).toContain("suite_calendar_bridge_open_conflicts 0");
      expect(lines).toContain(
        'suite_calendar_bridge_runs_total{kind="bridge",result="internal"} 1',
      );
      expect(lines).not.toContain(poisoned);
      expect(lines).not.toContain(ownerA);
      expect(lines).not.toContain("secret");
      expect(lines).not.toContain("owner");
      r.database.close();
    });
  });
});
