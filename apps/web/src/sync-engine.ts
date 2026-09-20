import type {
  ClientRegistrationResponse,
  SyncRoundRequest,
  SyncRoundResponse,
  SyncSnapshotResponse,
} from "@suite/contracts";
import type { LocalClientIdentity, LocalStore } from "./local-store.ts";

export interface SyncTransport {
  registerClient(): Promise<ClientRegistrationResponse>;
  snapshot(client: LocalClientIdentity): Promise<SyncSnapshotResponse>;
  syncRound(
    client: LocalClientIdentity,
    request: SyncRoundRequest,
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
  ) {}

  async ensureClient(): Promise<LocalClientIdentity> {
    return this.store.ensureClient(() => this.transport.registerClient());
  }

  async sync(pullLimit = 100): Promise<SyncRoundResponse> {
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
      response = await this.transport.syncRound(client, request);
    } catch (error) {
      if (!(error instanceof SyncCursorResetRequired)) throw error;
      await this.store.markResetRequired();
      await this.store.replaceFromSnapshot(
        await this.transport.snapshot(client),
      );
      const resetClient = await this.ensureClient();
      response = await this.transport.syncRound(resetClient, {
        ...request,
        cursor: resetClient.cursor,
      });
    }
    await this.store.applySyncRound(response);
    return response;
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
