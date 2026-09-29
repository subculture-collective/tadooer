import type { BridgeEnvelope, NormalizedBridgeEvent } from "./envelope.ts";

export type BridgeSideName = "google" | "baikal";

/** One observed event. Revisions and proofs are opaque provider tokens. */
export type BridgeObservation =
  | {
      readonly kind: "present";
      readonly nativeId: string;
      readonly revision: string;
      readonly event: NormalizedBridgeEvent;
    }
  | {
      readonly kind: "deleted";
      readonly nativeId: string;
      readonly proof: string;
    };

export type BridgeListResult =
  | {
      readonly kind: "ok";
      readonly events: readonly BridgeObservation[];
      /** Cursor to store after the pass; null when the side has none. */
      readonly cursor: string | null;
      /**
       * True when unlisted events are unchanged since the cursor. When false
       * the listing is bounded, so an unlisted event must be read directly:
       * absence never proves deletion.
       */
      readonly incremental: boolean;
    }
  | { readonly kind: "reset-required" }
  | { readonly kind: "unavailable"; readonly reason: string };

export type BridgeReadResult =
  BridgeObservation | { readonly kind: "unavailable"; readonly reason: string };

export type BridgeWriteResult =
  | { readonly kind: "ok" }
  /** Destination revision no longer matches; re-read and reconcile. */
  | { readonly kind: "precondition-failed" }
  /** Reserved create identity already exists; verify by reading. */
  | { readonly kind: "exists" }
  /** Target does not exist. */
  | { readonly kind: "gone" }
  /** Definitely not applied (authorization, rate limit); may be sent later. */
  | { readonly kind: "retry"; readonly reason: string }
  /** May have been applied; the next pass reads before any resend. */
  | { readonly kind: "uncertain"; readonly reason: string };

/**
 * Provider side of a mapping (ADR 0041). Implementations never retry and
 * send every write conditionally. A write is one request, except a Google
 * recurring series (ADR 0042): the master and each changed instance are
 * separate conditional requests, and a failure after the first committed
 * one is reported as `uncertain`.
 */
export interface BridgeSide {
  readonly name: BridgeSideName;
  listChanges(cursor: string | null): Promise<BridgeListResult>;
  read(nativeId: string): Promise<BridgeReadResult>;
  /** Stable destination identity reserved before any create is sent. */
  reserveNativeId(linkId: string): string;
  create(
    nativeId: string,
    uid: string | null,
    envelope: BridgeEnvelope,
  ): Promise<BridgeWriteResult>;
  update(
    nativeId: string,
    uid: string | null,
    expectedRevision: string,
    envelope: BridgeEnvelope,
  ): Promise<BridgeWriteResult>;
  delete(
    nativeId: string,
    expectedRevision: string,
  ): Promise<BridgeWriteResult>;
}
