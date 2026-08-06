import type {
  ClientRegistrationResponse,
  SyncRoundRequest,
  SyncRoundResponse,
} from "@suite/contracts";
import { LocalStore, type LocalClientIdentity } from "./local-store.ts";

export interface SyncTransport {
  registerClient(): Promise<ClientRegistrationResponse>;
  syncRound(
    client: LocalClientIdentity,
    request: SyncRoundRequest,
  ): Promise<SyncRoundResponse>;
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
    const client = await this.ensureClient();
    const outbox = await this.store.loadOutbox();
    const response = await this.transport.syncRound(client, {
      cursor: client.cursor,
      operations: outbox
        .filter(({ state }) => state === "queued" || state === "sending")
        .map(({ operation }) => operation),
      pullLimit,
    });
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
