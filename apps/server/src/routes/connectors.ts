import type { BaikalStatusResponse } from "@suite/contracts";
import { baikalConnectRequestSchema } from "@suite/contracts";
import {
  sendJson,
  sendError,
  readJson,
  sameOrigin,
  securityHeaders,
} from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";
import { connectorStatus } from "./shared.ts";

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
      sendError(
        response,
        connectorStatus(result.reason),
        "BAIKAL_UNAVAILABLE",
        "Baïkal connection could not be verified",
      );
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
      console.warn("connector.baikal.verification_failed");
      sendError(
        response,
        connectorStatus(result.reason),
        "BAIKAL_VERIFICATION_FAILED",
        "Baïkal credentials or endpoint could not be verified",
      );
      return true;
    }
    console.info("connector.baikal.verified");
    sendJson(response, 200, result.status);
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
    const authorization = google.begin(session.owner.id);
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
    const ownerId = await google.complete(state, code);
    if (ownerId === undefined) {
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
      Location: "/?google=connected",
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
    sendJson(response, 200, await google.synchronize(session.owner.id));
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
    sendJson(response, 200, await google.disconnect(session.owner.id));
    return true;
  }

  return false;
};
