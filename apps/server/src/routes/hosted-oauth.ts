import type { IncomingMessage, ServerResponse } from "node:http";
import { automationTokenScopeSchema } from "@suite/contracts";
import {
  clientAddress,
  readJson,
  sameOrigin,
  sendJson,
} from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";

const formLimit = 16 * 1024;
const requiredAuthorizationParameters = [
  "response_type",
  "client_id",
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method",
  "resource",
  "scope",
] as const;

const oauthError = (
  response: ServerResponse,
  status: number,
  error: string,
  description: string,
): void => {
  sendJson(response, status, { error, error_description: description });
};

const readForm = async (request: IncomingMessage): Promise<URLSearchParams> => {
  if (
    request.headers["content-type"]?.split(";", 1)[0]?.trim() !==
    "application/x-www-form-urlencoded"
  )
    throw new Error("CONTENT_TYPE");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > formLimit) {
      request.resume();
      throw new Error("BODY_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
};

const unique = (
  parameters: URLSearchParams,
  name: string,
): string | undefined => {
  const values = parameters.getAll(name);
  return values.length === 1 ? values[0] : undefined;
};

interface AttemptWindow {
  count: number;
  resetAt: number;
}

class OAuthRateLimiter {
  readonly #attempts = new Map<string, AttemptWindow>();

  allows(key: string, now = Date.now()): boolean {
    const window = this.#attempts.get(key);
    if (window === undefined || window.resetAt <= now) return true;
    return window.count < 20;
  }

  record(key: string, now = Date.now()): void {
    const window = this.#attempts.get(key);
    if (window === undefined || window.resetAt <= now)
      this.#attempts.set(key, { count: 1, resetAt: now + 15 * 60_000 });
    else window.count += 1;
  }
}

const limiter = new OAuthRateLimiter();

export const handleHostedOAuth: RouteHandler = async (
  request,
  response,
  url,
  ctx,
) => {
  const oauth = ctx.hostedOAuth;
  if (oauth === undefined) return false;
  const method = request.method ?? "GET";
  const origin = oauth.issuer;

  if (
    method === "GET" &&
    url.pathname === "/.well-known/oauth-authorization-server"
  ) {
    sendJson(response, 200, {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: automationTokenScopeSchema.options,
    });
    return true;
  }

  if (
    method === "GET" &&
    url.pathname === "/.well-known/oauth-protected-resource"
  ) {
    sendJson(response, 200, {
      resource: oauth.resource,
      authorization_servers: [origin],
      scopes_supported: automationTokenScopeSchema.options,
      bearer_methods_supported: ["header"],
    });
    return true;
  }

  if (method === "GET" && url.pathname === "/oauth/authorize") {
    if (request.url === undefined || request.url.length > 4096) {
      oauthError(
        response,
        400,
        "invalid_request",
        "Authorization request is invalid",
      );
      return true;
    }
    const values = Object.fromEntries(
      requiredAuthorizationParameters.map((name) => [
        name,
        unique(url.searchParams, name),
      ]),
    ) as Record<
      (typeof requiredAuthorizationParameters)[number],
      string | undefined
    >;
    const known = new Set<string>(requiredAuthorizationParameters);
    if (
      Object.values(values).some((value) => value === undefined) ||
      [...url.searchParams.keys()].some((name) => !known.has(name))
    ) {
      oauthError(
        response,
        400,
        "invalid_request",
        "Authorization request is invalid",
      );
      return true;
    }
    const clientId = values.client_id ?? "";
    const key = `${clientAddress(request, ctx.config.trustedProxyCidrs ?? [])}:${clientId}`;
    if (!limiter.allows(key)) {
      oauthError(
        response,
        429,
        "temporarily_unavailable",
        "Too many authorization attempts",
      );
      return true;
    }
    const client = oauth.clients.get(clientId);
    const redirectUri = values.redirect_uri ?? "";
    if (!client?.redirectUris.includes(redirectUri)) {
      limiter.record(key);
      oauthError(
        response,
        400,
        "invalid_request",
        "Client or redirect URI is invalid",
      );
      return true;
    }
    const session = ctx.auth.authenticate(request, false);
    if (session === undefined) {
      oauthError(
        response,
        401,
        "access_denied",
        "Owner authentication is required",
      );
      return true;
    }
    const created = oauth.createConsentRequest(session.owner.id, {
      responseType: values.response_type ?? "",
      clientId,
      redirectUri,
      state: values.state ?? "",
      codeChallenge: values.code_challenge ?? "",
      codeChallengeMethod: values.code_challenge_method ?? "",
      resource: values.resource ?? "",
      scope: values.scope ?? "",
    });
    if (created === undefined) {
      limiter.record(key);
      oauthError(
        response,
        400,
        "invalid_request",
        "Authorization request is invalid",
      );
      return true;
    }
    sendJson(response, 200, {
      request_id: created.id,
      request_proof: created.requestProof,
      client: { id: client.id, name: client.name },
      redirect_uri: redirectUri,
      resource: oauth.resource,
      scopes: (values.scope ?? "").split(" "),
      state: values.state,
    });
    return true;
  }

  if (method === "POST" && url.pathname === "/oauth/consent") {
    const session = sameOrigin(request)
      ? ctx.auth.authenticate(request, true)
      : undefined;
    const body = await readJson(request);
    if (
      session === undefined ||
      !ctx.auth.csrfMatches(
        session,
        request.headers["x-csrf-token"] as string | undefined,
      ) ||
      typeof body !== "object" ||
      body === null
    ) {
      oauthError(
        response,
        403,
        "access_denied",
        "Valid owner consent is required",
      );
      return true;
    }
    const input = body as Record<string, unknown>;
    if (
      typeof input.request_id !== "string" ||
      typeof input.request_proof !== "string" ||
      typeof input.state !== "string" ||
      typeof input.approved !== "boolean" ||
      Object.keys(input).some(
        (key) =>
          !["request_id", "request_proof", "state", "approved"].includes(key),
      )
    ) {
      oauthError(response, 400, "invalid_request", "Consent input is invalid");
      return true;
    }
    const result = oauth.consent({
      ownerId: session.owner.id,
      requestId: input.request_id,
      requestProof: input.request_proof,
      state: input.state,
      approved: input.approved,
    });
    if (result === undefined) {
      oauthError(
        response,
        400,
        "invalid_request",
        "Consent request expired or was already used",
      );
      return true;
    }
    const redirect = new URL(result.redirectUri);
    redirect.searchParams.set("state", result.state);
    if (result.denied === true)
      redirect.searchParams.set("error", "access_denied");
    else redirect.searchParams.set("code", result.code ?? "");
    response.writeHead(303, {
      "Cache-Control": "no-store",
      Location: redirect.href,
      "Referrer-Policy": "no-referrer",
    });
    response.end();
    return true;
  }

  if (method === "POST" && url.pathname === "/oauth/token") {
    if (request.headers.origin !== undefined) {
      oauthError(
        response,
        403,
        "invalid_request",
        "Browser token requests are forbidden",
      );
      return true;
    }
    const form = await readForm(request);
    const grantType = unique(form, "grant_type");
    const clientId = unique(form, "client_id") ?? "";
    const resource = unique(form, "resource") ?? "";
    const key = `${clientAddress(request, ctx.config.trustedProxyCidrs ?? [])}:${clientId}`;
    if (!limiter.allows(key)) {
      oauthError(
        response,
        429,
        "temporarily_unavailable",
        "Too many token attempts",
      );
      return true;
    }
    if (grantType === "authorization_code") {
      const expected = new Set([
        "grant_type",
        "code",
        "client_id",
        "redirect_uri",
        "resource",
        "code_verifier",
      ]);
      if ([...form.keys()].some((name) => !expected.has(name))) {
        oauthError(
          response,
          400,
          "invalid_request",
          "Token request is invalid",
        );
        return true;
      }
      const result = oauth.exchangeCode({
        code: unique(form, "code") ?? "",
        clientId,
        redirectUri: unique(form, "redirect_uri") ?? "",
        resource,
        codeVerifier: unique(form, "code_verifier") ?? "",
      });
      if (result === undefined) {
        limiter.record(key);
        oauthError(
          response,
          400,
          "invalid_grant",
          "Authorization grant is invalid",
        );
        return true;
      }
      sendJson(response, 200, {
        access_token: result.accessToken,
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: result.refreshToken,
        scope: result.scope,
      });
      return true;
    }
    if (grantType === "refresh_token") {
      const expected = new Set([
        "grant_type",
        "refresh_token",
        "client_id",
        "resource",
        "scope",
      ]);
      if ([...form.keys()].some((name) => !expected.has(name))) {
        oauthError(
          response,
          400,
          "invalid_request",
          "Token request is invalid",
        );
        return true;
      }
      const scope = form.has("scope") ? unique(form, "scope") : undefined;
      if (form.has("scope") && scope === undefined) {
        oauthError(
          response,
          400,
          "invalid_request",
          "Token request is invalid",
        );
        return true;
      }
      const result = oauth.refresh({
        refreshToken: unique(form, "refresh_token") ?? "",
        clientId,
        resource,
        ...(scope === undefined ? {} : { scope }),
      });
      if (result === undefined) {
        limiter.record(key);
        oauthError(response, 400, "invalid_grant", "Refresh grant is invalid");
        return true;
      }
      sendJson(response, 200, {
        access_token: result.accessToken,
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: result.refreshToken,
        scope: result.scope,
      });
      return true;
    }
    oauthError(
      response,
      400,
      "unsupported_grant_type",
      "Grant type is not supported",
    );
    return true;
  }

  if (method === "POST" && url.pathname === "/oauth/revoke") {
    if (request.headers.origin !== undefined) {
      oauthError(
        response,
        403,
        "invalid_request",
        "Browser revocation requests are forbidden",
      );
      return true;
    }
    const form = await readForm(request);
    const expected = new Set(["token", "client_id", "token_type_hint"]);
    const token = unique(form, "token");
    const clientId = unique(form, "client_id");
    if (
      token === undefined ||
      clientId === undefined ||
      [...form.keys()].some((name) => !expected.has(name))
    ) {
      oauthError(
        response,
        400,
        "invalid_request",
        "Revocation request is invalid",
      );
      return true;
    }
    oauth.revoke(token, clientId);
    sendJson(response, 200, {});
    return true;
  }

  return false;
};
