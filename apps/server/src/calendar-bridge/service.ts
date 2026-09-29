import { randomUUID } from "node:crypto";
import type {
  CalendarBridgeDirectionName,
  CalendarBridgeInitialSync,
  CalendarBridgeMappingCreateResult,
  SuiteDatabase,
} from "@suite/persistence";
import type { BaikalConnectorService } from "../connector.ts";
import type { GoogleConnectorService } from "../google-connector.ts";
import { runBridgeOnce, type BridgeRunResult } from "./engine.ts";
import { createCalDavBridgeSide, createGoogleBridgeSide } from "./providers.ts";

export type CalendarBridgeRunOutcome =
  | BridgeRunResult
  | { readonly kind: "not-found" }
  /** Another pass for this mapping is running in this process. */
  | { readonly kind: "busy" }
  | {
      readonly kind: "blocked";
      readonly reason:
        | "google-not-connected"
        | "google-consent-required"
        | "google-reconnect-required"
        | "google-unavailable"
        | "calendar-unavailable"
        | "baikal-credential-unavailable";
    };

/**
 * Owner-facing bridge operations (ADR 0041). `runOnce` is the single entry
 * point for the #46 worker and the owner route; it resolves credentials for
 * one pass and serializes passes per mapping within this process.
 */
export class CalendarBridgeService {
  readonly #running = new Set<string>();

  constructor(
    private readonly database: SuiteDatabase,
    private readonly baikal: BaikalConnectorService,
    private readonly google: GoogleConnectorService,
  ) {}

  createMapping(
    ownerId: string,
    input: {
      readonly googleCalendarId: string;
      readonly baikalCalendarId: string;
      readonly direction: CalendarBridgeDirectionName;
      readonly initialSync: CalendarBridgeInitialSync;
    },
    now: string,
  ):
    | CalendarBridgeMappingCreateResult
    | { readonly kind: "consent-required" }
    | { readonly kind: "google-calendar-not-writable" } {
    // Every direction writes Google or reads it with the bridge grant.
    if (!this.google.hasBridgeConsent(ownerId))
      return { kind: "consent-required" };
    // ADR 0040: a direction that writes Google needs a writer or owner role.
    if (
      input.direction !== "google_to_baikal" &&
      !this.google.writeCapability(ownerId, input.googleCalendarId).writable
    )
      return { kind: "google-calendar-not-writable" };
    return this.database.calendarBridge.createMapping({
      id: randomUUID(),
      ownerId,
      ...input,
      now,
    });
  }

  async runOnce(
    ownerId: string,
    mappingId: string,
    now = new Date(),
  ): Promise<CalendarBridgeRunOutcome> {
    const store = this.database.calendarBridge;
    const mapping = store.getMapping(ownerId, mappingId);
    if (mapping === undefined) return { kind: "not-found" };
    if (!mapping.enabled) return { kind: "disabled" };
    if (this.#running.has(mapping.id)) return { kind: "busy" };
    this.#running.add(mapping.id);
    const iso = now.toISOString();
    const block = (
      reason: Extract<CalendarBridgeRunOutcome, { kind: "blocked" }>["reason"],
    ): CalendarBridgeRunOutcome => {
      store.recordRun({
        mappingId: mapping.id,
        now: iso,
        outcome: { kind: "failure", errorCode: reason },
      });
      return { kind: "blocked", reason };
    };
    try {
      const googleCalendar = this.database.getOwnedCalendar(
        ownerId,
        mapping.googleCalendarId,
      );
      if (googleCalendar?.kind !== "google")
        return block("calendar-unavailable");
      const baikalAccess = this.baikal.bridgeAccess(
        ownerId,
        mapping.baikalCalendarId,
      );
      if (!baikalAccess.ok)
        return block(
          baikalAccess.reason === "calendar-not-found"
            ? "calendar-unavailable"
            : "baikal-credential-unavailable",
        );
      const googleAccess = await this.google.bridgeAccess(ownerId, now);
      if (!googleAccess.ok) return block(`google-${googleAccess.reason}`);
      return await runBridgeOnce({
        store,
        mapping,
        now: iso,
        google: createGoogleBridgeSide({
          accessToken: googleAccess.accessToken,
          calendarId: googleCalendar.href,
          fetch: googleAccess.fetch,
        }),
        baikal: createCalDavBridgeSide({
          collectionUrl: baikalAccess.collectionUrl,
          username: baikalAccess.username,
          password: baikalAccess.password,
          now: iso,
          fetch: baikalAccess.fetch,
        }),
      });
    } finally {
      this.#running.delete(mapping.id);
    }
  }
}
