import { z } from "zod";

/**
 * Trusted-device sessions (ADR 0048, issue #115): the device list in
 * Settings, the recent-password gate and its confirmation route.
 */

/**
 * Owner decision 2026-10-02: days a trusted device stays signed in without
 * owner activity. The server policy and the sign-in text both read it.
 */
export const trustedDeviceSessionDays = 30;

/** A sensitive route answered 403 with this code: confirm the password, retry. */
export const reauthenticationRequiredCode = "REAUTHENTICATION_REQUIRED";

export const passwordConfirmationRequestSchema = z.object({
  password: z.string().min(1).max(1024),
});

export const passwordConfirmationResponseSchema = z.object({
  confirmedAt: z.iso.datetime(),
  /** Sensitive routes accept this confirmation until then. */
  validUntil: z.iso.datetime(),
});

export const deviceAddressFamilySchema = z.enum(["ipv4", "ipv6"]);

export const signedInDeviceSchema = z.object({
  id: z.uuid(),
  label: z.string().min(1).max(100),
  createdAt: z.iso.datetime(),
  /** Last owner activity; background sync does not move it. */
  lastSeenAt: z.iso.datetime(),
  /** Only the family of the last address is stored, never the address. */
  lastAddressFamily: deviceAddressFamilySchema.nullable(),
  /** When the device is signed out unless the owner uses it before then. */
  expiresAt: z.iso.datetime(),
  /** The device that made this request. */
  current: z.boolean(),
});

export const deviceSecurityEventSchema = z.object({
  deviceId: z.uuid(),
  label: z.string().min(1).max(100),
  /** A sign-in token that had already been replaced was presented again. */
  kind: z.literal("token-reuse"),
  occurredAt: z.iso.datetime(),
});

export const signedInDevicesResponseSchema = z.object({
  devices: z.array(signedInDeviceSchema),
  securityEvents: z.array(deviceSecurityEventSchema),
});

export const signedInDeviceRenameRequestSchema = z.object({
  label: z.string().trim().min(1).max(100),
});

export const devicesSignedOutResponseSchema = z.object({
  signedOut: z.number().int().nonnegative(),
});

export type PasswordConfirmationResponse = z.infer<
  typeof passwordConfirmationResponseSchema
>;
export type DevicesSignedOutResponse = z.infer<
  typeof devicesSignedOutResponseSchema
>;
export type DeviceAddressFamily = z.infer<typeof deviceAddressFamilySchema>;
export type SignedInDevice = z.infer<typeof signedInDeviceSchema>;
export type DeviceSecurityEvent = z.infer<typeof deviceSecurityEventSchema>;
export type SignedInDevicesResponse = z.infer<
  typeof signedInDevicesResponseSchema
>;
