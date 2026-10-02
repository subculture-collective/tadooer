import { trustedDeviceSessionDays } from "@suite/contracts";

/**
 * Every session lifetime and interval in one place (ADR 0007, ADR 0048).
 *
 * Owner decision 2026-10-02: a trusted device stays signed in for 30 days.
 * That is the sliding window below. The 180-day absolute cap, the 15-minute
 * recent-password window and the unchanged browser limits were proposed in
 * issue #115 and not contradicted; ADR 0048 lists them as defaults awaiting
 * confirmation. Changing a value here changes it everywhere.
 */

const minute = 60 * 1000;
const hour = 60 * minute;
const day = 24 * hour;

export interface SessionLifetime {
  /** Owner activity extends the session by this much, up to the cap. */
  readonly idleMs: number;
  /** Measured from sign-in; nothing extends it. */
  readonly absoluteMs: number;
}

export const sessionPolicy = {
  /** An ordinary browser session (ADR 0007), unchanged by ADR 0048. */
  browser: { idleMs: 30 * minute, absoluteMs: 12 * hour },
  /** "Keep me signed in on this device for 30 days". */
  trustedDevice: {
    idleMs: trustedDeviceSessionDays * day,
    absoluteMs: 180 * day,
  },
  /** A trusted device's token is replaced at most this often, on use. */
  tokenRotationIntervalMs: day,
  /**
   * How long a replaced token is still accepted after the device first
   * presented its successor. It covers requests the device sent before it
   * stored the new cookie.
   */
  tokenRotationOverlapMs: minute,
  /**
   * A successor that was sent but never presented may not have arrived. The
   * current token stays valid, and the next request after this long gets a
   * new successor.
   */
  tokenReissueAfterMs: hour,
  /** Sensitive routes on a trusted device need a password this recent. */
  recentPasswordMs: 15 * minute,
  /** How long a device revoked for token reuse stays visible in Settings. */
  tokenReuseRecordRetentionMs: 30 * day,
} as const satisfies {
  readonly browser: SessionLifetime;
  readonly trustedDevice: SessionLifetime;
  readonly tokenRotationIntervalMs: number;
  readonly tokenRotationOverlapMs: number;
  readonly tokenReissueAfterMs: number;
  readonly recentPasswordMs: number;
  readonly tokenReuseRecordRetentionMs: number;
};
