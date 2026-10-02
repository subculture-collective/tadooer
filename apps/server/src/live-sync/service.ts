import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  clientAuthenticationHeadersSchema,
  liveSyncEventNames,
  type AutomationPreviewCommand,
  type LiveSyncResourceFamily,
} from "@suite/contracts";
import type { SuiteDatabase } from "@suite/persistence";
import type { AuthService } from "../auth.ts";
import { LiveSyncHub, type LiveSyncTimers } from "./hub.ts";
import {
  automationOperationFamilies,
  classifyLiveSyncRoute,
  unclassifiedRouteFamilies,
} from "./resource-families.ts";

interface NotedMutation {
  readonly ownerId: string;
  readonly families: readonly LiveSyncResourceFamily[];
}

/**
 * Connects the hub to the server (ADR 0045): it reads feed heads, decides
 * which resource families a finished request touched and renders metrics.
 * Nothing here reads or forwards record content.
 */
export class LiveSyncService {
  readonly hub: LiveSyncHub;
  readonly #database: SuiteDatabase;
  readonly #auth: AuthService;
  readonly #noted = new WeakMap<ServerResponse, NotedMutation>();
  #unclassified = 0;

  constructor(
    database: SuiteDatabase,
    auth: AuthService,
    timers?: LiveSyncTimers,
  ) {
    this.#database = database;
    this.#auth = auth;
    this.hub = new LiveSyncHub({
      ...(timers === undefined ? {} : { timers }),
      onTick: () => {
        this.refresh();
      },
    });
  }

  /**
   * Ends streams whose session or client is no longer valid, then compares
   * each connected owner's feed head with the last one announced. Runs after
   * every mutating request and on the hub's two-second tick, which also sees
   * writes by server ticks and by another process on the same database.
   */
  refresh(): void {
    if (this.hub.openStreams === 0) return;
    try {
      this.hub.sweep();
      for (const ownerId of this.hub.owners())
        this.hub.publishHead(ownerId, this.#database.getSyncState(ownerId));
    } catch {
      console.error("live_sync.refresh_failed");
    }
  }

  /**
   * Records what an automation operation changed. Automation requests carry
   * a bearer credential, so the handler names the owner and the operation;
   * the hint is sent when the response has finished successfully.
   */
  noteAutomation(
    response: ServerResponse,
    ownerId: string,
    operation: AutomationPreviewCommand["operation"],
  ): void {
    this.#noted.set(response, {
      ownerId,
      families: [...automationOperationFamilies[operation], "automation"],
    });
  }

  /** Called when a response has been sent. Never throws. */
  afterRequest(request: IncomingMessage, response: ServerResponse): void {
    try {
      this.#afterRequest(request, response);
    } catch {
      console.error("live_sync.request_hook_failed");
    }
  }

  #afterRequest(request: IncomingMessage, response: ServerResponse): void {
    const method = request.method ?? "GET";
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (!pathname.startsWith("/api/") || response.statusCode >= 400) return;
    const classification = classifyLiveSyncRoute(method, pathname);
    // Reads are skipped, except the few GET routes that change records.
    if (
      classification === undefined &&
      !["POST", "PUT", "PATCH", "DELETE"].includes(method)
    )
      return;
    if (classification === undefined) this.#unclassified += 1;
    if (this.hub.openStreams === 0) return;
    this.refresh();
    const noted = this.#noted.get(response);
    const families =
      noted?.families ??
      (classification === undefined
        ? unclassifiedRouteFamilies
        : classification.kind === "families"
          ? classification.families
          : []);
    if (families.length === 0) return;
    const ownerId =
      noted?.ownerId ?? this.#auth.authenticate(request, false)?.owner.id;
    if (ownerId === undefined) return;
    this.hub.publishResources(
      ownerId,
      families,
      this.#sourceClient(request, ownerId),
    );
  }

  /**
   * The registered client that sent the request, when it carried a valid
   * client proof. Read-only: it does not update the client's last-seen time.
   */
  #sourceClient(request: IncomingMessage, ownerId: string): string | null {
    const headers = clientAuthenticationHeadersSchema.safeParse({
      clientId: request.headers["x-suite-client-id"],
      clientCredential: request.headers["x-suite-client-credential"],
    });
    if (!headers.success) return null;
    const client = this.#database
      .listSyncClients(ownerId)
      .find(({ id }) => id === headers.data.clientId);
    if (client?.revokedAt !== null) return null;
    const presented = Buffer.from(
      createHash("sha256")
        .update(headers.data.clientCredential)
        .digest("base64url"),
    );
    const expected = Buffer.from(client.credentialHash);
    return presented.length === expected.length &&
      timingSafeEqual(presented, expected)
      ? client.id
      : null;
  }

  /** Prometheus lines for `/api/metrics`; counts only, no identifiers. */
  metricLines(): readonly string[] {
    const metrics = this.hub.metrics();
    return [
      "# HELP suite_live_sync_streams_open Open live sync hint streams.",
      "# TYPE suite_live_sync_streams_open gauge",
      `suite_live_sync_streams_open ${String(metrics.openStreams)}`,
      "# HELP suite_live_sync_hints_total Live sync events written, by event name.",
      "# TYPE suite_live_sync_hints_total counter",
      ...liveSyncEventNames.map(
        (event) =>
          `suite_live_sync_hints_total{event="${event}"} ${String(metrics.hints[event])}`,
      ),
      "# HELP suite_live_sync_streams_dropped_total Streams dropped because the socket could not be written.",
      "# TYPE suite_live_sync_streams_dropped_total counter",
      `suite_live_sync_streams_dropped_total ${String(metrics.dropped)}`,
      "# HELP suite_live_sync_unclassified_mutations_total Successful mutations without a resource family classification; each sent the all family.",
      "# TYPE suite_live_sync_unclassified_mutations_total counter",
      `suite_live_sync_unclassified_mutations_total ${String(this.#unclassified)}`,
    ];
  }

  /** Ends every stream with `bye: shutdown`. */
  close(): void {
    this.hub.close();
  }
}
