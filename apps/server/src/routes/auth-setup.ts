import type {
  DevicesSignedOutResponse,
  PasswordConfirmationResponse,
  SetupStatusResponse,
  SessionResponse,
  SignedInDevicesResponse,
} from "@suite/contracts";
import {
  ownerSetupRequestSchema,
  loginRequestSchema,
  passwordConfirmationRequestSchema,
  signedInDeviceRenameRequestSchema,
} from "@suite/contracts";
import {
  clearSessionCookie,
  deviceLabelFromUserAgent,
  LoginRateLimiter,
  passwordMeetsPolicy,
  sessionCookie,
} from "../auth.ts";
import { reauthenticationRequired } from "../reauthentication.ts";
import { isIP } from "node:net";
import {
  sendJson,
  sendError,
  readJson,
  sameOrigin,
  clientAddress,
} from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";

/**
 * One limiter for sign-in and for password confirmation (ADR 0048): both
 * check the owner's password, so failures on either count towards the same
 * lockout for an address and username.
 */
const loginLimiter = new LoginRateLimiter();

const devicePattern = /^\/api\/auth\/devices\/([0-9a-f-]{36})$/;

export const handleAuthSetup: RouteHandler = async (
  request,
  response,
  url,
  ctx,
) => {
  const { auth, config } = ctx;
  const method = request.method ?? "GET";
  const limiterKeyFor = (from: typeof request, username: string): string =>
    `${clientAddress(from, config.trustedProxyCidrs ?? [])}:${username.toLowerCase()}`;
  /** Session, same origin and CSRF for the mutating routes below. */
  const ownerSession = (refresh = true) => {
    const session = sameOrigin(request)
      ? auth.authenticate(request, refresh)
      : undefined;
    if (
      session !== undefined &&
      auth.csrfMatches(
        session,
        request.headers["x-csrf-token"] as string | undefined,
      )
    )
      return session;
    sendError(
      response,
      403,
      "CSRF_INVALID",
      "Valid session and CSRF token required",
    );
    return undefined;
  };

  if (method === "GET" && url.pathname === "/api/setup/status") {
    const body: SetupStatusResponse = {
      setupRequired: auth.setupRequired(),
    };
    sendJson(response, 200, body);
    return true;
  }

  if (method === "POST" && url.pathname === "/api/setup") {
    if (!sameOrigin(request)) {
      sendError(
        response,
        403,
        "ORIGIN_REQUIRED",
        "Same-origin request required",
      );
      return true;
    }
    const parsed = ownerSetupRequestSchema.safeParse(await readJson(request));
    if (!parsed.success || !passwordMeetsPolicy(parsed.data.password)) {
      sendError(response, 400, "INVALID_SETUP", "Owner setup input is invalid");
      return true;
    }
    const created = await auth.setup(parsed.data);
    if (!created) {
      sendError(
        response,
        409,
        "SETUP_COMPLETE",
        "Owner setup is already complete",
      );
      return true;
    }
    console.info("auth.setup.completed");
    const body: SetupStatusResponse = { setupRequired: false };
    sendJson(response, 201, body);
    return true;
  }

  if (method === "POST" && url.pathname === "/api/auth/login") {
    if (!sameOrigin(request)) {
      sendError(
        response,
        403,
        "ORIGIN_REQUIRED",
        "Same-origin request required",
      );
      return true;
    }
    const parsed = loginRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      sendError(
        response,
        401,
        "INVALID_CREDENTIALS",
        "Invalid username or password",
      );
      return true;
    }
    const limiterKey = limiterKeyFor(request, parsed.data.username);
    if (!loginLimiter.allows(limiterKey)) {
      console.warn("auth.login.rate_limited");
      sendError(response, 429, "LOGIN_RATE_LIMITED", "Too many login attempts");
      return true;
    }
    const address = isIP(
      clientAddress(request, config.trustedProxyCidrs ?? []),
    );
    // A sign-in from a device that is already trusted replaces that session.
    const replaced = auth.authenticate(request, false);
    const session = await auth.login(
      parsed.data.username,
      parsed.data.password,
      parsed.data.trustDevice === true
        ? {
            label: deviceLabelFromUserAgent(request.headers["user-agent"]),
            addressFamily:
              address === 4 ? "ipv4" : address === 6 ? "ipv6" : null,
          }
        : undefined,
    );
    if (session === undefined) {
      loginLimiter.failed(limiterKey);
      console.warn("auth.login.failed");
      sendError(
        response,
        401,
        "INVALID_CREDENTIALS",
        "Invalid username or password",
      );
      return true;
    }
    loginLimiter.succeeded(limiterKey);
    if (
      replaced !== undefined &&
      replaced.deviceId !== null &&
      replaced.owner.id === session.owner.id
    )
      auth.revoke(replaced);
    console.info(
      session.deviceId === null
        ? "auth.login.succeeded"
        : "auth.login.succeeded_trusted_device",
    );
    sendJson(response, 200, auth.response(session), {
      "Set-Cookie": sessionCookie(session.cookie, config.secureCookies),
    });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/auth/session") {
    const session = auth.resume(request);
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
      return true;
    }
    const body: SessionResponse = auth.response(session);
    sendJson(response, 200, body);
    return true;
  }

  if (method === "POST" && url.pathname === "/api/auth/logout") {
    if (!sameOrigin(request)) {
      sendError(
        response,
        403,
        "ORIGIN_REQUIRED",
        "Same-origin request required",
      );
      return true;
    }
    const session = auth.authenticate(request, true);
    if (
      session === undefined ||
      !auth.csrfMatches(
        session,
        request.headers["x-csrf-token"] as string | undefined,
      )
    ) {
      sendError(
        response,
        403,
        "CSRF_INVALID",
        "Valid session and CSRF token required",
      );
      return true;
    }
    auth.revoke(session);
    console.info("auth.logout.completed");
    sendJson(
      response,
      200,
      { loggedOut: true },
      {
        "Set-Cookie": clearSessionCookie(config.secureCookies),
      },
    );
    return true;
  }

  // ADR 0048: confirm the password for the recent-password gate.
  if (method === "POST" && url.pathname === "/api/auth/confirm-password") {
    const session = ownerSession();
    if (session === undefined) return true;
    const limiterKey = limiterKeyFor(request, session.owner.username);
    if (!loginLimiter.allows(limiterKey)) {
      console.warn("auth.password_confirmation.rate_limited");
      sendError(response, 429, "LOGIN_RATE_LIMITED", "Too many login attempts");
      return true;
    }
    const parsed = passwordConfirmationRequestSchema.safeParse(
      await readJson(request),
    );
    const confirmed = parsed.success
      ? await auth.confirmPassword(session, parsed.data.password)
      : undefined;
    if (confirmed === undefined) {
      loginLimiter.failed(limiterKey);
      console.warn("auth.password_confirmation.failed");
      // 403, not 401: the session itself is still valid.
      sendError(response, 403, "INVALID_CREDENTIALS", "Incorrect password");
      return true;
    }
    loginLimiter.succeeded(limiterKey);
    console.info("auth.password_confirmation.succeeded");
    const body: PasswordConfirmationResponse = confirmed;
    sendJson(response, 200, body);
    return true;
  }

  // ADR 0048: the device registry.
  if (method === "GET" && url.pathname === "/api/auth/devices") {
    const session = auth.authenticate(request, false);
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
      return true;
    }
    const listed = auth.listDevices(session);
    const body: SignedInDevicesResponse = {
      devices: [...listed.devices],
      securityEvents: [...listed.securityEvents],
    };
    sendJson(response, 200, body);
    return true;
  }

  if (
    method === "POST" &&
    url.pathname === "/api/auth/devices/sign-out-others"
  ) {
    const session = ownerSession();
    if (session === undefined) return true;
    if (reauthenticationRequired(auth, session, response)) return true;
    const body: DevicesSignedOutResponse = {
      signedOut: auth.revokeOtherSessions(session),
    };
    console.info("auth.devices.signed_out_others");
    sendJson(response, 200, body);
    return true;
  }

  const deviceMatch = devicePattern.exec(url.pathname);
  if (deviceMatch !== null && (method === "PATCH" || method === "DELETE")) {
    const session = ownerSession();
    if (session === undefined) return true;
    const deviceId = deviceMatch[1] ?? "";
    if (method === "PATCH") {
      const parsed = signedInDeviceRenameRequestSchema.safeParse(
        await readJson(request),
      );
      if (!parsed.success) {
        sendError(response, 400, "INVALID_DEVICE", "Device label is invalid");
        return true;
      }
      if (!auth.renameDevice(session, deviceId, parsed.data.label)) {
        sendError(response, 404, "DEVICE_NOT_FOUND", "Device not found");
        return true;
      }
      sendJson(response, 200, { renamed: true });
      return true;
    }
    // Signing this device out is a sign-out and needs no password; signing
    // another device out is a device trust change and is gated.
    const current = deviceId === session.deviceId;
    if (!current && reauthenticationRequired(auth, session, response))
      return true;
    if (!auth.revokeDevice(session, deviceId)) {
      sendError(response, 404, "DEVICE_NOT_FOUND", "Device not found");
      return true;
    }
    console.info("auth.device.signed_out");
    const body: DevicesSignedOutResponse = { signedOut: 1 };
    sendJson(
      response,
      200,
      body,
      current ? { "Set-Cookie": clearSessionCookie(config.secureCookies) } : {},
    );
    return true;
  }

  return false;
};
