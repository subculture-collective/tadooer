import type {
  ClientRegistrationResponse,
  SyncRoundRequest,
  SyncRoundResponse,
  SyncSnapshotResponse,
} from "@suite/contracts";
import type { LocalClientIdentity, LocalStore } from "./local-store.ts";
import {
  browserLocks,
  syncRoundExclusive,
  type RunExclusive,
} from "./live-sync/locks.ts";

/**
 * Why a round runs when the owner did not ask for it. `push` rounds follow a
 * live sync hint or the fallback interval and are sent with
 * `x-suite-sync-trigger: push` (ADR 0045).
 */
export type SyncRoundTrigger = "push";

export interface SyncTransport {
  registerClient(): Promise<ClientRegistrationResponse>;
  snapshot(client: LocalClientIdentity): Promise<SyncSnapshotResponse>;
  syncRound(
    client: LocalClientIdentity,
    request: SyncRoundRequest,
    trigger?: SyncRoundTrigger,
  ): Promise<SyncRoundResponse>;
}

export class SyncCursorResetRequired extends Error {
  constructor() {
    super("The sync cursor must be reset from a full snapshot");
  }
}

export class SyncEngine {
  constructor(
    private readonly store: LocalStore,
    private readonly transport: SyncTransport,
    /**
     * Serializes rounds across the tabs of one browser profile (ADR 0045).
     * A round reads the outbox, sends it and applies the outcomes inside the
     * lock, so a second tab reads entries only after they are acknowledged.
     */
    private readonly exclusive: RunExclusive = syncRoundExclusive(
      browserLocks(),
    ),
  ) {}

  async ensureClient(): Promise<LocalClientIdentity> {
    return this.store.ensureClient(() => this.transport.registerClient());
  }

  sync(
    pullLimit = 100,
    trigger?: SyncRoundTrigger,
  ): Promise<SyncRoundResponse> {
    return this.exclusive(() => this.#round(pullLimit, trigger));
  }

  async #round(
    pullLimit: number,
    trigger: SyncRoundTrigger | undefined,
  ): Promise<SyncRoundResponse> {
    let client = await this.ensureClient();
    if (await this.store.requiresSnapshot()) {
      await this.store.replaceFromSnapshot(
        await this.transport.snapshot(client),
      );
      client = await this.ensureClient();
    }
    const outbox = await this.store.loadOutbox();
    const request = {
      cursor: client.cursor,
      operations: outbox
        .filter(({ state }) => state === "queued" || state === "sending")
        .map(({ operation }) => operation),
      pullLimit,
    } satisfies SyncRoundRequest;
    let response: SyncRoundResponse;
    try {
      response = await this.#send(client, request, trigger);
    } catch (error) {
      if (!(error instanceof SyncCursorResetRequired)) throw error;
      await this.store.markResetRequired();
      await this.store.replaceFromSnapshot(
        await this.transport.snapshot(client),
      );
      const resetClient = await this.ensureClient();
      response = await this.#send(
        resetClient,
        { ...request, cursor: resetClient.cursor },
        trigger,
      );
    }
    await this.store.applySyncRound(response);
    return response;
  }

  #send(
    client: LocalClientIdentity,
    request: SyncRoundRequest,
    trigger: SyncRoundTrigger | undefined,
  ): Promise<SyncRoundResponse> {
    return trigger === undefined
      ? this.transport.syncRound(client, request)
      : this.transport.syncRound(client, request, trigger);
  }
}

export const installOnlineSync = (
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  sync: () => Promise<unknown>,
): (() => void) => {
  const onOnline = () => {
    void sync();
  };
  target.addEventListener("online", onOnline);
  return () => target.removeEventListener("online", onOnline);
};
