import type { SetupStatusResponse, SessionResponse } from "@suite/contracts";
import { ownerSetupRequestSchema, loginRequestSchema } from "@suite/contracts";
import {
  clearSessionCookie,
  LoginRateLimiter,
  passwordMeetsPolicy,
  sessionCookie,
} from "../auth.ts";
import {
  sendJson,
  sendError,
  readJson,
  sameOrigin,
  clientAddress,
} from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";

const loginLimiter = new LoginRateLimiter();

export const handleAuthSetup: RouteHandler = async (
  request,
  response,
  url,
  ctx,
) => {
  const { auth, config } = ctx;
  const method = request.method ?? "GET";

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
    const limiterKey = `${clientAddress(request, config.trustedProxyCidrs ?? [])}:${parsed.data.username.toLowerCase()}`;
    if (!loginLimiter.allows(limiterKey)) {
      console.warn("auth.login.rate_limited");
      sendError(response, 429, "LOGIN_RATE_LIMITED", "Too many login attempts");
      return true;
    }
    const session = await auth.login(
      parsed.data.username,
      parsed.data.password,
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
    console.info("auth.login.succeeded");
    sendJson(response, 200, auth.response(session), {
      "Set-Cookie": sessionCookie(session.token, config.secureCookies),
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

  return false;
};
