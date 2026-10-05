import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import {
  automationTokenScopeSchema,
  type AutomationTokenScope,
} from "@suite/contracts";
import type { SuiteDatabase } from "@suite/persistence";

export interface HostedOAuthClient {
  readonly id: string;
  readonly name: string;
  readonly redirectUris: readonly string[];
}

const digest = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("base64url");

const expires = (now: string, milliseconds: number): string =>
  new Date(Date.parse(now) + milliseconds).toISOString();

const parseRedirect = (value: string): string => {
  const redirect = new URL(value);
  const loopback =
    redirect.hostname === "127.0.0.1" || redirect.hostname === "[::1]";
  if (
    redirect.username !== "" ||
    redirect.password !== "" ||
    redirect.hash !== "" ||
    (redirect.protocol !== "https:" &&
      !(redirect.protocol === "http:" && loopback))
  )
    throw new Error("Hosted OAuth client redirect URI is invalid");
  return redirect.href;
};

export const loadHostedOAuthClients = (
  path: string,
): ReadonlyMap<string, HostedOAuthClient> => {
  if ((statSync(path).mode & 0o077) !== 0)
    throw new Error("Hosted OAuth client configuration must be mode 0600");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new Error("Hosted OAuth client configuration must contain clients");
  const clients = new Map<string, HostedOAuthClient>();
  for (const candidate of parsed) {
    if (typeof candidate !== "object" || candidate === null)
      throw new Error("Hosted OAuth client configuration is invalid");
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      !/^[A-Za-z0-9._~-]{1,100}$/.test(record.id) ||
      typeof record.name !== "string" ||
      record.name.trim().length < 1 ||
      record.name.length > 100 ||
      !Array.isArray(record.redirectUris) ||
      record.redirectUris.length < 1 ||
      record.redirectUris.some((uri) => typeof uri !== "string") ||
      clients.has(record.id)
    )
      throw new Error("Hosted OAuth client configuration is invalid");
    const redirectUris = (record.redirectUris as string[]).map(parseRedirect);
    if (new Set(redirectUris).size !== redirectUris.length)
      throw new Error("Hosted OAuth client redirect URIs must be unique");
    clients.set(record.id, {
      id: record.id,
      name: record.name.trim(),
      redirectUris,
    });
  }
  return clients;
};

export class HostedOAuthService {
  readonly clients: ReadonlyMap<string, HostedOAuthClient>;

  constructor(
    private readonly database: SuiteDatabase,
    readonly issuer: string,
    readonly resource: string,
    clientConfigPath: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly random: () => string = () =>
      randomBytes(32).toString("base64url"),
  ) {
    this.clients = loadHostedOAuthClients(clientConfigPath);
  }

  private audit(input: {
    readonly ownerId?: string;
    readonly clientId?: string;
    readonly subjectId?: string;
    readonly phase:
      "authorize" | "consent" | "token" | "refresh" | "revoke" | "resource";
    readonly outcome: "succeeded" | "denied" | "failed" | "rate_limited";
    readonly errorCode?: string;
    readonly scopes?: readonly string[];
  }): void {
    this.database.hostedOAuth.appendAudit({
      id: randomUUID(),
      ownerId: input.ownerId ?? null,
      clientId: input.clientId ?? null,
      subjectId: input.subjectId ?? null,
      phase: input.phase,
      outcome: input.outcome,
      errorCode: input.errorCode ?? null,
      scopes: input.scopes ?? [],
      resource: this.resource,
      createdAt: this.now(),
    });
  }

  validateAuthorization(input: {
    readonly responseType: string;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly state: string;
    readonly codeChallenge: string;
    readonly codeChallengeMethod: string;
    readonly resource: string;
    readonly scope: string;
  }):
    | { client: HostedOAuthClient; scopes: readonly AutomationTokenScope[] }
    | undefined {
    const client = this.clients.get(input.clientId);
    const requested = input.scope.split(" ").filter(Boolean);
    const parsedScopes = requested.map((scope) =>
      automationTokenScopeSchema.safeParse(scope),
    );
    if (
      client === undefined ||
      input.responseType !== "code" ||
      !client.redirectUris.includes(input.redirectUri) ||
      input.state.length < 32 ||
      input.state.length > 512 ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge) ||
      input.codeChallengeMethod !== "S256" ||
      input.resource !== this.resource ||
      requested.length === 0 ||
      new Set(requested).size !== requested.length ||
      parsedScopes.some((scope) => !scope.success)
    )
      return undefined;
    return {
      client,
      scopes: parsedScopes.map((scope) => {
        if (!scope.success) throw new Error("Unreachable invalid scope");
        return scope.data;
      }),
    };
  }

  createConsentRequest(
    ownerId: string,
    input: Parameters<HostedOAuthService["validateAuthorization"]>[0],
  ): { id: string; requestProof: string } | undefined {
    const valid = this.validateAuthorization(input);
    if (valid === undefined) return undefined;
    const now = this.now();
    const id = randomUUID();
    const requestProof = this.random();
    this.database.hostedOAuth.createRequest({
      id,
      requestHash: digest(requestProof),
      ownerId,
      clientId: valid.client.id,
      redirectUri: input.redirectUri,
      resource: input.resource,
      scopes: valid.scopes,
      stateHash: digest(input.state),
      codeChallenge: input.codeChallenge,
      expiresAt: expires(now, 10 * 60_000),
      consumedAt: null,
      createdAt: now,
    });
    this.audit({
      ownerId,
      clientId: valid.client.id,
      subjectId: id,
      phase: "authorize",
      outcome: "succeeded",
      scopes: valid.scopes,
    });
    return { id, requestProof };
  }

  consent(input: {
    readonly ownerId: string;
    readonly requestId: string;
    readonly requestProof: string;
    readonly state: string;
    readonly approved: boolean;
  }):
    | { redirectUri: string; state: string; code?: string; denied?: true }
    | undefined {
    const now = this.now();
    const request = this.database.hostedOAuth.consumeRequest(
      input.requestId,
      digest(input.requestProof),
      input.ownerId,
      now,
    );
    if (request?.stateHash !== digest(input.state)) {
      this.audit({
        ownerId: input.ownerId,
        phase: "consent",
        outcome: "failed",
        errorCode: "invalid_request",
      });
      return undefined;
    }
    if (!input.approved) {
      this.audit({
        ownerId: input.ownerId,
        clientId: request.clientId,
        subjectId: request.id,
        phase: "consent",
        outcome: "denied",
        errorCode: "access_denied",
        scopes: request.scopes,
      });
      return {
        redirectUri: request.redirectUri,
        state: input.state,
        denied: true,
      };
    }
    const grantId = randomUUID();
    const code = this.random();
    this.database.hostedOAuth.issueCode(
      {
        id: grantId,
        ownerId: input.ownerId,
        clientId: request.clientId,
        resource: request.resource,
        scopes: request.scopes,
        createdAt: now,
        expiresAt: expires(now, 30 * 24 * 60 * 60_000),
        revokedAt: null,
      },
      {
        codeHash: digest(code),
        grantId,
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        resource: request.resource,
        scopes: request.scopes,
        codeChallenge: request.codeChallenge,
        expiresAt: expires(now, 60_000),
        consumedAt: null,
        createdAt: now,
      },
    );
    this.audit({
      ownerId: input.ownerId,
      clientId: request.clientId,
      subjectId: grantId,
      phase: "consent",
      outcome: "succeeded",
      scopes: request.scopes,
    });
    return { redirectUri: request.redirectUri, state: input.state, code };
  }

  exchangeCode(input: {
    readonly code: string;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly resource: string;
    readonly codeVerifier: string;
  }): { accessToken: string; refreshToken: string; scope: string } | undefined {
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)) {
      this.audit({
        clientId: input.clientId,
        phase: "token",
        outcome: "failed",
        errorCode: "invalid_grant",
      });
      return undefined;
    }
    const now = this.now();
    const accessToken = this.random();
    const refreshToken = this.random();
    const challenge = digest(input.codeVerifier);
    const exchanged = this.database.hostedOAuth.exchangeCode(
      digest(input.code),
      input.clientId,
      input.redirectUri,
      input.resource,
      challenge,
      now,
      digest(accessToken),
      expires(now, 15 * 60_000),
      digest(refreshToken),
      expires(now, 30 * 24 * 60 * 60_000),
    );
    if (exchanged === undefined) {
      this.audit({
        clientId: input.clientId,
        phase: "token",
        outcome: "failed",
        errorCode: "invalid_grant",
      });
      return undefined;
    }
    this.audit({
      clientId: input.clientId,
      subjectId: exchanged.grantId,
      phase: "token",
      outcome: "succeeded",
      scopes: exchanged.scopes,
    });
    return {
      accessToken,
      refreshToken,
      scope: exchanged.scopes.join(" "),
    };
  }

  refresh(input: {
    readonly refreshToken: string;
    readonly clientId: string;
    readonly resource: string;
    readonly scope?: string;
  }): { accessToken: string; refreshToken: string; scope: string } | undefined {
    const requested = (input.scope ?? "").split(" ").filter(Boolean);
    if (
      this.clients.get(input.clientId) === undefined ||
      input.resource !== this.resource ||
      (input.scope !== undefined &&
        (requested.length === 0 ||
          new Set(requested).size !== requested.length ||
          requested.some(
            (scope) => !automationTokenScopeSchema.safeParse(scope).success,
          )))
    )
      return undefined;
    const current = this.database.hostedOAuth.authenticateRefresh(
      digest(input.refreshToken),
      input.clientId,
      input.resource,
    );
    if (current === undefined) {
      this.audit({
        clientId: input.clientId,
        phase: "refresh",
        outcome: "failed",
        errorCode: "invalid_grant",
      });
      return undefined;
    }
    const scopes = input.scope === undefined ? current.scopes : requested;
    const now = this.now();
    const accessToken = this.random();
    const refreshToken = this.random();
    const result = this.database.hostedOAuth.rotateRefresh(
      digest(input.refreshToken),
      input.clientId,
      input.resource,
      scopes,
      now,
      digest(accessToken),
      expires(now, 15 * 60_000),
      digest(refreshToken),
      expires(now, 30 * 24 * 60 * 60_000),
    );
    if (result !== "rotated") {
      this.audit({
        clientId: input.clientId,
        subjectId: current.grantId,
        phase: "refresh",
        outcome: "failed",
        errorCode: result === "reused" ? "refresh_reuse" : "invalid_grant",
        scopes,
      });
      return undefined;
    }
    this.audit({
      clientId: input.clientId,
      subjectId: current.grantId,
      phase: "refresh",
      outcome: "succeeded",
      scopes,
    });
    return { accessToken, refreshToken, scope: scopes.join(" ") };
  }

  revoke(token: string, clientId: string): void {
    if (this.clients.has(clientId))
      this.database.hostedOAuth.revokeTokenFamily(
        digest(token),
        clientId,
        this.now(),
      );
    this.audit({ clientId, phase: "revoke", outcome: "succeeded" });
  }

  authenticateAccess(token: string, requiredScope?: string) {
    const authenticated = this.database.hostedOAuth.authenticateAccess(
      digest(token),
      this.resource,
      requiredScope,
      this.now(),
    );
    this.audit({
      phase: "resource",
      ...(authenticated === undefined
        ? { outcome: "denied" as const, errorCode: "invalid_token" }
        : {
            outcome: "succeeded" as const,
            ownerId: authenticated.ownerId,
            clientId: authenticated.clientId,
            subjectId: authenticated.grantId,
            scopes: authenticated.scopes,
          }),
    });
    return authenticated;
  }
}
