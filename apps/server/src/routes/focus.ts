import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  clientAuthenticationHeadersSchema,
  focusIdleRequestSchema,
  focusPlanRequestSchema,
  focusPreferencesSchema,
  type FocusIdleResponse,
  type FocusPreferencesResponse,
} from "@suite/contracts";
import { applyIdleDisposition, planFromPreferences } from "@suite/domain";
import type { SuiteDatabase } from "@suite/persistence";
import { focusTimerBody, observeOwnerSession } from "../focus-timer.ts";
import { readJson, sameOrigin, sendError, sendJson } from "../http-utils.ts";
import type { RouteContext, RouteHandler } from "./shared.ts";
import {
  activeFromPersistence,
  activeResponse,
  eventsFromActive,
  intervalsFromActive,
  recordFromActive,
} from "./shared.ts";

/**
 * Focus preferences, session plans, idle disposition and break reminders
 * (issue #65, ADR 0029). Preference writes enter the sync feed for the
 * read-only offline cache; plans, idle state and reminders remain online-only.
 *
 * - GET/PUT /api/focus/preferences        revisioned owner record (If-Match)
 * - GET  /api/focus/timer                 derived timer and reminder state
 * - PUT  /api/focus/plan                  set or clear the session's preset
 * - POST /api/focus/idle                  apply an idle disposition
 * - POST /api/focus/break-reminder/snooze snooze the take-a-break reminder
 */

export const focusPreferencesBody = (
  database: SuiteDatabase,
  ownerId: string,
): FocusPreferencesResponse => database.focus.getPreferences(ownerId);

const parseIfMatch = (request: IncomingMessage): number | undefined => {
  const header = request.headers["if-match"];
  const value = typeof header === "string" ? header.trim() : undefined;
  const match = value === undefined ? null : /^"?(\d+)"?$/.exec(value);
  return match?.[1] === undefined ? undefined : Number(match[1]);
};

const authenticateClient = (
  request: IncomingMessage,
  ctx: RouteContext,
  mutating: boolean,
):
  | { readonly ownerId: string; readonly clientId: string }
  | {
      readonly status: number;
      readonly code: string;
      readonly message: string;
    } => {
  const session = ctx.auth.authenticate(request, mutating);
  if (session === undefined)
    return {
      status: 401,
      code: "AUTH_REQUIRED",
      message: "Authentication required",
    };
  if (
    mutating &&
    (!sameOrigin(request) ||
      !ctx.auth.csrfMatches(
        session,
        request.headers["x-csrf-token"] as string | undefined,
      ))
  )
    return {
      status: 403,
      code: "CSRF_REQUIRED",
      message: "Same-origin session and CSRF token required",
    };
  const headers = clientAuthenticationHeadersSchema.safeParse({
    clientId: request.headers["x-suite-client-id"],
    clientCredential: request.headers["x-suite-client-credential"],
  });
  const client = headers.success
    ? ctx.stores.authenticateSyncClient(
        session.owner.id,
        headers.data.clientId,
        createHash("sha256")
          .update(headers.data.clientCredential)
          .digest("base64url"),
        new Date().toISOString(),
      )
    : undefined;
  if (client === undefined)
    return {
      status: 401,
      code: "CLIENT_AUTH_REQUIRED",
      message: "Valid client proof required",
    };
  return { ownerId: session.owner.id, clientId: client.id };
};

export const handleFocus: RouteHandler = async (
  request,
  response,
  url,
  ctx,
) => {
  const { stores: database, auth, sessionClock } = ctx;
  const method = request.method ?? "GET";
  const path = url.pathname;

  if (
    path === "/api/focus/preferences" &&
    (method === "GET" || method === "PUT")
  ) {
    const mutating = method === "PUT";
    const session = auth.authenticate(request, mutating);
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
      return true;
    }
    if (!mutating) {
      sendJson(response, 200, focusPreferencesBody(database, session.owner.id));
      return true;
    }
    if (
      !sameOrigin(request) ||
      !auth.csrfMatches(
        session,
        request.headers["x-csrf-token"] as string | undefined,
      )
    ) {
      sendError(response, 403, "CSRF_REQUIRED", "Valid CSRF token required");
      return true;
    }
    const expected = parseIfMatch(request);
    if (expected === undefined) {
      sendError(
        response,
        428,
        "IF_MATCH_REQUIRED",
        "Send the preference revision in If-Match",
      );
      return true;
    }
    const parsed = focusPreferencesSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_FOCUS_PREFERENCES",
        "Focus preferences are invalid",
      );
      return true;
    }
    const saved = database.focus.putPreferences(
      session.owner.id,
      expected,
      parsed.data,
      sessionClock.now().toISOString(),
    );
    if (saved === undefined) {
      sendError(
        response,
        412,
        "FOCUS_PREFERENCES_CONFLICT",
        "Focus preferences changed; reload them before saving",
      );
      return true;
    }
    sendJson(response, 200, saved);
    return true;
  }

  if (path === "/api/focus/timer" && method === "GET") {
    const actor = authenticateClient(request, ctx, false);
    if ("status" in actor) {
      sendError(response, actor.status, actor.code, actor.message);
      return true;
    }
    sendJson(
      response,
      200,
      focusTimerBody(database, sessionClock, actor.ownerId),
    );
    return true;
  }

  if (path === "/api/focus/plan" && method === "PUT") {
    const actor = authenticateClient(request, ctx, true);
    if ("status" in actor) {
      sendError(response, actor.status, actor.code, actor.message);
      return true;
    }
    const parsed = focusPlanRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      sendError(response, 400, "INVALID_FOCUS_PLAN", "Focus plan is invalid");
      return true;
    }
    const session = observeOwnerSession(database, sessionClock, actor.ownerId);
    if (
      session?.id !== parsed.data.sessionId ||
      session.state === "completed" ||
      session.state === "expired"
    ) {
      sendError(
        response,
        404,
        "ACTIVE_SESSION_NOT_FOUND",
        "Active session not found",
      );
      return true;
    }
    if (session.revision !== parsed.data.expectedRevision) {
      sendError(
        response,
        412,
        "ACTIVE_SESSION_CONFLICT",
        "Session changed; reload it before setting a plan",
      );
      return true;
    }
    if (session.controllerClientId !== actor.clientId) {
      sendError(
        response,
        409,
        "ACTIVE_SESSION_CONFLICT",
        "Only the controlling device sets the plan",
      );
      return true;
    }
    const preferences = database.focus.getPreferences(
      actor.ownerId,
    ).preferences;
    const plan =
      parsed.data.mode === null
        ? null
        : planFromPreferences(preferences, parsed.data.mode);
    database.focus.putPlan(
      actor.ownerId,
      session.id,
      plan === null
        ? null
        : {
            ...plan,
            flowtime: {
              ...plan.flowtime,
              breakRules: [...plan.flowtime.breakRules],
            },
          },
      sessionClock.now().toISOString(),
    );
    sendJson(
      response,
      200,
      focusTimerBody(database, sessionClock, actor.ownerId),
    );
    return true;
  }

  if (path === "/api/focus/idle" && method === "POST") {
    const actor = authenticateClient(request, ctx, true);
    if ("status" in actor) {
      sendError(response, actor.status, actor.code, actor.message);
      return true;
    }
    const parsed = focusIdleRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_IDLE_DISPOSITION",
        "Idle disposition is invalid",
      );
      return true;
    }
    const command = parsed.data;
    const requestHash = createHash("sha256")
      .update(JSON.stringify(command))
      .digest("base64url");
    const prior = database.getActiveSessionOperationOutcome(
      actor.ownerId,
      actor.clientId,
      command.idempotencyKey,
    );
    if (prior !== undefined) {
      if (prior.requestHash !== requestHash) {
        sendError(
          response,
          409,
          "IDEMPOTENCY_CONFLICT",
          "The idempotency key was used for another command",
        );
        return true;
      }
      const replayed = activeFromPersistence(
        prior.snapshot.session,
        prior.snapshot.intervals,
        prior.snapshot.events,
      );
      const stored = database.focus
        .listIdleDispositions(actor.ownerId, replayed.id)
        .find((record) => record.revision === replayed.revision);
      if (stored === undefined) {
        sendError(response, 409, "IDEMPOTENCY_CONFLICT", "Outcome mismatch");
        return true;
      }
      const body: FocusIdleResponse = {
        session: activeResponse(replayed),
        correction: {
          disposition: stored.disposition,
          idleStartedAt: stored.idleStartedAt,
          idleEndedAt: stored.idleEndedAt,
          trimmedMs: stored.trimmedMs,
        },
        replayed: true,
      };
      sendJson(response, 200, body);
      return true;
    }
    const session = observeOwnerSession(database, sessionClock, actor.ownerId);
    if (session?.id !== command.sessionId) {
      sendError(
        response,
        404,
        "ACTIVE_SESSION_NOT_FOUND",
        "Active session not found",
      );
      return true;
    }
    if (session.state === "completed" || session.state === "expired") {
      sendError(
        response,
        409,
        "ACTIVE_SESSION_CONFLICT",
        "The session ended before the idle time could be assigned",
      );
      return true;
    }
    const result = applyIdleDisposition(
      session,
      {
        actorClientId: actor.clientId,
        expectedRevision: command.expectedRevision,
        idleStartedAt: command.idleStartedAt,
        disposition: command.disposition,
      },
      sessionClock,
      { intervalId: () => randomUUID() },
    );
    if (!result.ok) {
      sendError(
        response,
        result.reason === "stale-revision"
          ? 412
          : result.reason === "invalid-idle-span"
            ? 400
            : 409,
        result.reason === "invalid-idle-span"
          ? "INVALID_IDLE_DISPOSITION"
          : "ACTIVE_SESSION_CONFLICT",
        result.reason,
      );
      return true;
    }
    const next = result.session;
    const applied = database.applyActiveSessionTransition({
      session: recordFromActive(next),
      expectedRevision: session.revision,
      clientId: actor.clientId,
      idempotencyKey: command.idempotencyKey,
      requestHash,
      intervals: intervalsFromActive(next),
      events: eventsFromActive(next),
      now: next.updatedAt,
      inTransaction: () => {
        database.focus.recordIdleDisposition({
          id: randomUUID(),
          sessionId: next.id,
          ownerId: actor.ownerId,
          revision: next.revision,
          disposition: result.correction.disposition,
          idleStartedAt: result.correction.idleStartedAt,
          idleEndedAt: result.correction.idleEndedAt,
          trimmedMs: result.correction.trimmedMs,
          actorClientId: actor.clientId,
          createdAt: next.updatedAt,
        });
      },
    });
    if (applied.kind === "conflict" || applied.kind === "stale") {
      sendError(
        response,
        409,
        "ACTIVE_SESSION_CONFLICT",
        "Session changed; reload it before trying again",
      );
      return true;
    }
    const body: FocusIdleResponse = {
      session: activeResponse(next),
      correction: result.correction,
      replayed: applied.kind === "replayed",
    };
    sendJson(response, 200, body);
    return true;
  }

  if (path === "/api/focus/break-reminder/snooze" && method === "POST") {
    const session = auth.authenticate(request, true);
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
      return true;
    }
    if (
      !sameOrigin(request) ||
      !auth.csrfMatches(
        session,
        request.headers["x-csrf-token"] as string | undefined,
      )
    ) {
      sendError(response, 403, "CSRF_REQUIRED", "Valid CSRF token required");
      return true;
    }
    const now = sessionClock.now();
    const minutes = database.focus.getPreferences(session.owner.id).preferences
      .takeABreak.snoozeMinutes;
    const snoozedUntil = new Date(
      now.getTime() + minutes * 60_000,
    ).toISOString();
    database.focus.snoozeBreakReminder(
      session.owner.id,
      snoozedUntil,
      now.toISOString(),
    );
    sendJson(response, 200, { snoozedUntil });
    return true;
  }

  return false;
};
