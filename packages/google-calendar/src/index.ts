/** Default read-only grant. Every connection requires both. */
export const googleReadScopes = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
] as const;
/** @deprecated Use {@link googleReadScopes}; kept for existing callers. */
export const googleScopes = googleReadScopes;
/**
 * The single write scope requested only by the explicit write-consent flow
 * (ADR 0040): event create/update/delete, no calendar settings or ACLs.
 */
export const googleWriteScope =
  "https://www.googleapis.com/auth/calendar.events" as const;

export type GoogleAccessRequest = "read" | "write";
export type GoogleAccessRole = "freeBusyReader" | "reader" | "writer" | "owner";

export const hasGoogleReadScopes = (scopes: readonly string[]): boolean =>
  googleReadScopes.every((scope) => scopes.includes(scope));
export const hasGoogleWriteScope = (scopes: readonly string[]): boolean =>
  scopes.includes(googleWriteScope);
export const googleRoleAllowsWrites = (
  role: GoogleAccessRole | null | undefined,
): boolean => role === "writer" || role === "owner";

export type GoogleWriteRefusal =
  | "not-connected"
  | "reconnect-required"
  | "consent-required"
  | "scope-missing"
  | "role-unknown"
  | "read-only-calendar";
export type GoogleWriteCapability =
  | { readonly writable: true }
  | { readonly writable: false; readonly reason: GoogleWriteRefusal };

/**
 * Pure write gate (ADR 0040). A Google calendar is writable only with a live
 * connector, recorded owner consent, a grant carrying the write scope and a
 * last observed `writer`/`owner` role. Checks run in that order so the reason
 * names the first thing the owner has to fix.
 */
export const evaluateGoogleWriteCapability = (input: {
  readonly connectorState:
    "disconnected" | "connected" | "stale" | "reconnect_required";
  readonly writeConsentAt: string | null;
  readonly grantedScopes: readonly string[];
  readonly accessRole: GoogleAccessRole | null;
}): GoogleWriteCapability => {
  if (input.connectorState === "disconnected")
    return { writable: false, reason: "not-connected" };
  if (input.connectorState === "reconnect_required")
    return { writable: false, reason: "reconnect-required" };
  if (input.writeConsentAt === null)
    return { writable: false, reason: "consent-required" };
  if (!hasGoogleWriteScope(input.grantedScopes))
    return { writable: false, reason: "scope-missing" };
  if (input.accessRole === null)
    return { writable: false, reason: "role-unknown" };
  if (!googleRoleAllowsWrites(input.accessRole))
    return { writable: false, reason: "read-only-calendar" };
  return { writable: true };
};

export interface GoogleOAuthClientConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}
export interface GoogleTokenGrant {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: string;
  readonly scopes: readonly string[];
}
export interface GoogleCalendarSummary {
  readonly id: string;
  readonly etag: string;
  readonly summary: string;
  readonly timeZone: string | null;
  readonly accessRole: GoogleAccessRole;
  readonly primary: boolean;
  readonly deleted: boolean;
}
export interface GoogleEventProjection {
  readonly id: string;
  readonly iCalUid: string;
  readonly etag: string;
  readonly summary: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly allDay: boolean;
  readonly recurrence: "none" | "instance";
  readonly deleted: boolean;
  readonly raw: unknown;
}
export type GoogleSyncResult =
  | {
      readonly kind: "ok";
      readonly events: readonly GoogleEventProjection[];
      readonly nextSyncToken: string;
    }
  | { readonly kind: "reset-required" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "rate-limited"; readonly retryAfterSeconds: number }
  | { readonly kind: "failed"; readonly status: number };

const boundedJson = async (response: Response): Promise<unknown> => {
  const body = await response.text();
  if (Buffer.byteLength(body) > 4 * 1024 * 1024)
    throw new Error("Google response is too large");
  return JSON.parse(body) as unknown;
};
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const string = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/**
 * A read request asks only for the read scopes and does not opt into
 * incremental authorization, so a read-only reconnect never carries a prior
 * write scope forward. A write request is the separate, explicit consent step.
 */
export const buildGoogleAuthorizationUrl = (
  config: GoogleOAuthClientConfig,
  state: string,
  access: GoogleAccessRequest = "read",
): string => {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    ...(access === "write" ? { include_granted_scopes: "true" } : {}),
    scope: (access === "write"
      ? [...googleReadScopes, googleWriteScope]
      : [...googleReadScopes]
    ).join(" "),
    state,
  }).toString();
  return url.href;
};

const tokenGrant = (
  value: unknown,
  fallbackRefreshToken: string | null,
): GoogleTokenGrant | undefined => {
  const body = record(value);
  const accessToken = string(body?.access_token);
  const refreshToken = string(body?.refresh_token) ?? fallbackRefreshToken;
  const expiresIn = body?.expires_in;
  if (
    accessToken === undefined ||
    refreshToken === null ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn)
  )
    return undefined;
  // A response without `scope` is assumed to carry only the read scopes;
  // write access is never inferred (ADR 0040).
  const scopes = (string(body?.scope) ?? googleReadScopes.join(" "))
    .split(" ")
    .filter(Boolean);
  return {
    accessToken,
    refreshToken,
    expiresAt: new Date(
      Date.now() + Math.max(0, expiresIn - 30) * 1000,
    ).toISOString(),
    scopes,
  };
};

export const exchangeGoogleCode = async (
  config: GoogleOAuthClientConfig,
  code: string,
  fetcher: typeof fetch = fetch,
): Promise<GoogleTokenGrant | undefined> => {
  const response = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  return response.ok
    ? tokenGrant(await boundedJson(response), null)
    : undefined;
};
export const refreshGoogleAccess = async (
  config: GoogleOAuthClientConfig,
  refreshToken: string,
  fetcher: typeof fetch = fetch,
): Promise<GoogleTokenGrant | "invalid_grant" | undefined> => {
  const response = await fetcher("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) {
    const body = record(await boundedJson(response).catch(() => undefined));
    return body?.error === "invalid_grant" ? "invalid_grant" : undefined;
  }
  return tokenGrant(await boundedJson(response), refreshToken);
};
export const revokeGoogleGrant = async (
  refreshToken: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> =>
  (
    await fetcher("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }),
    })
  ).ok;

export const listGoogleCalendars = async (
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<readonly GoogleCalendarSummary[] | undefined> => {
  const calendars: GoogleCalendarSummary[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList",
    );
    url.searchParams.set("maxResults", "250");
    if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
    const response = await fetcher(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return undefined;
    const body = record(await boundedJson(response));
    const items = body?.items;
    if (!Array.isArray(items)) return undefined;
    for (const value of items) {
      const item = record(value);
      const id = string(item?.id);
      const etag = string(item?.etag);
      const summary = string(item?.summaryOverride) ?? string(item?.summary);
      const role = string(item?.accessRole);
      if (
        id &&
        etag &&
        summary &&
        ["freeBusyReader", "reader", "writer", "owner"].includes(role ?? "")
      )
        calendars.push({
          id,
          etag,
          summary,
          timeZone: string(item?.timeZone) ?? null,
          accessRole: role as GoogleAccessRole,
          primary: item?.primary === true,
          deleted: item?.deleted === true,
        });
    }
    pageToken = string(body?.nextPageToken);
  } while (pageToken !== undefined);
  return calendars;
};

const eventTime = (
  value: unknown,
): { value: string; allDay: boolean } | undefined => {
  const item = record(value);
  const dateTime = string(item?.dateTime);
  if (dateTime !== undefined && Number.isFinite(Date.parse(dateTime)))
    return { value: new Date(dateTime).toISOString(), allDay: false };
  const date = string(item?.date);
  if (date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(date))
    return { value: `${date}T00:00:00.000Z`, allDay: true };
  return undefined;
};
const projectEvent = (value: unknown): GoogleEventProjection | undefined => {
  const item = record(value);
  const id = string(item?.id);
  const etag = string(item?.etag);
  const status = string(item?.status);
  const iCalUid = string(item?.iCalUID) ?? id;
  if (!id || !etag || !iCalUid) return undefined;
  if (status === "cancelled")
    return {
      id,
      iCalUid,
      etag,
      summary: "",
      startsAt: "1970-01-01T00:00:00.000Z",
      endsAt: "1970-01-01T00:00:00.001Z",
      allDay: false,
      recurrence: "none",
      deleted: true,
      raw: value,
    };
  const start = eventTime(item?.start);
  const end = eventTime(item?.end);
  if (!start || !end || Date.parse(end.value) <= Date.parse(start.value))
    return undefined;
  return {
    id,
    iCalUid,
    etag,
    summary: string(item?.summary) ?? "Busy",
    startsAt: start.value,
    endsAt: end.value,
    allDay: start.allDay,
    recurrence:
      string(item?.recurringEventId) === undefined ? "none" : "instance",
    deleted: false,
    raw: value,
  };
};

export const syncGoogleEvents = async (
  accessToken: string,
  calendarId: string,
  syncToken: string | null,
  fetcher: typeof fetch = fetch,
): Promise<GoogleSyncResult> => {
  const events: GoogleEventProjection[] = [];
  let pageToken: string | undefined;
  let finalSyncToken: string | undefined;
  do {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    );
    url.searchParams.set("maxResults", "2500");
    url.searchParams.set("showDeleted", "true");
    url.searchParams.set("singleEvents", "true");
    if (syncToken !== null) url.searchParams.set("syncToken", syncToken);
    if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
    const response = await fetcher(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.status === 410) return { kind: "reset-required" };
    if (response.status === 401) return { kind: "unauthorized" };
    if (response.status === 429)
      return {
        kind: "rate-limited",
        retryAfterSeconds: Math.max(
          1,
          Number(response.headers.get("retry-after") ?? "1") || 1,
        ),
      };
    if (!response.ok) return { kind: "failed", status: response.status };
    const body = record(await boundedJson(response));
    const items = body?.items;
    if (!Array.isArray(items)) return { kind: "failed", status: 502 };
    for (const item of items) {
      const projected = projectEvent(item);
      if (projected !== undefined) events.push(projected);
    }
    pageToken = string(body?.nextPageToken);
    finalSyncToken = string(body?.nextSyncToken) ?? finalSyncToken;
  } while (pageToken !== undefined);
  return finalSyncToken === undefined
    ? { kind: "failed", status: 502 }
    : { kind: "ok", events, nextSyncToken: finalSyncToken };
};
