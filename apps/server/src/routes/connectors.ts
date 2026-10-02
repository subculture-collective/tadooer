import type {
  BaikalProbeResponse,
  BaikalStatusResponse,
} from "@suite/contracts";
import {
  baikalConnectRequestSchema,
  googleAuthorizationRequestSchema,
  googleSyncRequestSchema,
} from "@suite/contracts";
import {
  sendJson,
  sendError,
  readJson,
  sameOrigin,
  securityHeaders,
} from "../http-utils.ts";
import { reauthenticationRequired } from "../reauthentication.ts";
import type { RouteHandler } from "./shared.ts";
import { describeConnectorFailure } from "./shared.ts";

export const handleConnectors: RouteHandler = async (
  request,
  response,
  url,
  ctx,
) => {
  const { auth, baikal: connector, google } = ctx;
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/api/connectors/baikal") {
    const session = auth.authenticate(request, false);
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
      return true;
    }
    const result = await connector.status(session.owner.id);
    if (!result.ok) {
      const failure = describeConnectorFailure(result.reason);
      sendError(response, failure.status, failure.code, failure.message);
      return true;
    }
    const body: BaikalStatusResponse = result.status;
    sendJson(response, 200, body);
    return true;
  }

  if (method === "PUT" && url.pathname === "/api/connectors/baikal") {
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
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
      return true;
    }
    if (
      !auth.csrfMatches(
        session,
        request.headers["x-csrf-token"] as string | undefined,
      )
    ) {
      sendError(response, 403, "CSRF_INVALID", "Valid CSRF token required");
      return true;
    }
    if (reauthenticationRequired(auth, session, response)) return true;
    const parsed = baikalConnectRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_CONNECTOR",
        "Baïkal credentials are invalid",
      );
      return true;
    }
    const result = await connector.connect(
      session.owner.id,
      parsed.data.username,
      parsed.data.password,
    );
    if (!result.ok) {
      console.warn("connector.baikal.verification_failed", {
        reason: result.reason,
      });
      const failure = describeConnectorFailure(result.reason);
      sendError(response, failure.status, failure.code, failure.message);
      return true;
    }
    console.info("connector.baikal.verified");
    sendJson(response, 200, result.status);
    return true;
  }

  if (method === "POST" && url.pathname === "/api/connectors/baikal/probe") {
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
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
      return true;
    }
    if (
      !auth.csrfMatches(
        session,
        request.headers["x-csrf-token"] as string | undefined,
      )
    ) {
      sendError(response, 403, "CSRF_INVALID", "Valid CSRF token required");
      return true;
    }
    const parsed = baikalConnectRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_CONNECTOR",
        "Baïkal credentials are invalid",
      );
      return true;
    }
    const result = await connector.probe(
      parsed.data.username,
      parsed.data.password,
    );
    if (!result.ok) {
      console.warn("connector.baikal.probe_failed", { reason: result.reason });
      const failure = describeConnectorFailure(result.reason);
      sendError(response, failure.status, failure.code, failure.message);
      return true;
    }
    const body: BaikalProbeResponse = result.probe;
    sendJson(response, 200, body);
    return true;
  }

  if (method === "GET" && url.pathname === "/api/connectors/google") {
    const session = auth.authenticate(request, false);
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
      return true;
    }
    sendJson(response, 200, google.status(session.owner.id));
    return true;
  }

  if (
    method === "POST" &&
    url.pathname === "/api/connectors/google/authorize"
  ) {
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
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
      return true;
    }
    if (
      !auth.csrfMatches(
        session,
        request.headers["x-csrf-token"] as string | undefined,
      )
    ) {
      sendError(response, 403, "CSRF_INVALID", "Valid CSRF token required");
      return true;
    }
    if (reauthenticationRequired(auth, session, response)) return true;
    const input = googleAuthorizationRequestSchema.safeParse(
      request.headers["content-type"] === undefined
        ? {}
        : await readJson(request),
    );
    if (!input.success) {
      sendError(
        response,
        400,
        "INVALID_GOOGLE_AUTHORIZATION",
        "Invalid Google authorization request",
      );
      return true;
    }
    if (
      input.data.access === "write" &&
      google.configured() &&
      google.status(session.owner.id).state === "disconnected"
    ) {
      sendError(
        response,
        409,
        "GOOGLE_CONNECTION_REQUIRED",
        "Connect Google Calendar read-only before allowing event changes",
      );
      return true;
    }
    const authorization = google.begin(session.owner.id, input.data.access);
    if (authorization === undefined) {
      sendError(
        response,
        503,
        "GOOGLE_OAUTH_NOT_CONFIGURED",
        "Google OAuth configuration is not installed",
      );
      return true;
    }
    sendJson(response, 200, authorization, {
      "Cache-Control": "no-store",
    });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/connectors/google/callback") {
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (
      url.searchParams.get("error") !== null ||
      state === null ||
      code === null ||
      state.length < 32 ||
      state.length > 256 ||
      code.length < 4 ||
      code.length > 4096
    ) {
      sendError(
        response,
        400,
        "GOOGLE_AUTHORIZATION_REJECTED",
        "Google authorization was not completed",
      );
      return true;
    }
    const completed = await google.complete(state, code);
    if (completed === undefined) {
      sendError(
        response,
        400,
        "GOOGLE_AUTHORIZATION_INVALID",
        "Google authorization state or grant was invalid",
      );
      return true;
    }
    response.writeHead(303, {
      ...securityHeaders,
      "Cache-Control": "no-store",
      Location:
        completed.access === "read"
          ? "/?google=connected"
          : completed.writeGranted
            ? "/?google=write-granted"
            : "/?google=write-not-granted",
    });
    response.end();
    return true;
  }

  if (method === "POST" && url.pathname === "/api/connectors/google/sync") {
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
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
      return true;
    }
    if (
      !auth.csrfMatches(
        session,
        request.headers["x-csrf-token"] as string | undefined,
      )
    ) {
      sendError(response, 403, "CSRF_INVALID", "Valid CSRF token required");
      return true;
    }
    const input = googleSyncRequestSchema.safeParse(
      request.headers["content-type"] === undefined
        ? {}
        : await readJson(request),
    );
    if (!input.success) {
      sendError(
        response,
        400,
        "INVALID_GOOGLE_SYNC",
        "Invalid calendar sync options",
      );
      return true;
    }
    sendJson(
      response,
      200,
      await google.synchronize(session.owner.id, new Date(), input.data.full),
    );
    return true;
  }

  if (
    method === "DELETE" &&
    url.pathname === "/api/connectors/google/write-consent"
  ) {
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
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
      return true;
    }
    if (
      !auth.csrfMatches(
        session,
        request.headers["x-csrf-token"] as string | undefined,
      )
    ) {
      sendError(response, 403, "CSRF_INVALID", "Valid CSRF token required");
      return true;
    }
    if (reauthenticationRequired(auth, session, response)) return true;
    const status = google.withdrawWriteConsent(session.owner.id);
    if (status === undefined) {
      sendError(
        response,
        404,
        "GOOGLE_NOT_CONNECTED",
        "Google Calendar is not connected",
      );
      return true;
    }
    console.info("connector.google.write_consent_withdrawn");
    sendJson(response, 200, status);
    return true;
  }

  if (method === "DELETE" && url.pathname === "/api/connectors/google") {
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
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
      return true;
    }
    if (
      !auth.csrfMatches(
        session,
        request.headers["x-csrf-token"] as string | undefined,
      )
    ) {
      sendError(response, 403, "CSRF_INVALID", "Valid CSRF token required");
      return true;
    }
    if (reauthenticationRequired(auth, session, response)) return true;
    sendJson(response, 200, await google.disconnect(session.owner.id));
    return true;
  }

  return false;
};
