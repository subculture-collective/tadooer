import { randomUUID, createHash } from "node:crypto";
import type { ActiveSessionCommandResponse } from "@suite/contracts";
import {
  clientAuthenticationHeadersSchema,
  activeSessionCommandSchema,
} from "@suite/contracts";
import {
  createActiveSession,
  observeActiveSession,
  transitionActiveSession,
  type ActiveSession,
} from "@suite/domain";
import { sendJson, sendError, readJson, sameOrigin } from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";
import {
  activeResponse,
  activeFromRecord,
  activeFromPersistence,
  recordFromActive,
  intervalsFromActive,
  eventsFromActive,
} from "./shared.ts";

export const handleActiveSession: RouteHandler = async (
  request,
  response,
  url,
  ctx,
) => {
  const { stores: database, auth, sessionClock } = ctx;
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/api/active-session") {
    const session = auth.authenticate(request, false);
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
      return true;
    }
    const headers = clientAuthenticationHeadersSchema.safeParse({
      clientId: request.headers["x-suite-client-id"],
      clientCredential: request.headers["x-suite-client-credential"],
    });
    if (
      !headers.success ||
      database.authenticateSyncClient(
        session.owner.id,
        headers.data.clientId,
        createHash("sha256")
          .update(headers.data.clientCredential)
          .digest("base64url"),
        new Date().toISOString(),
      ) === undefined
    ) {
      sendError(
        response,
        401,
        "CLIENT_AUTH_REQUIRED",
        "Valid client proof required",
      );
      return true;
    }
    const stored = database.getActiveSession(session.owner.id);
    if (stored === undefined) {
      sendJson(response, 200, { session: null });
      return true;
    }
    const observed = observeActiveSession(
      activeFromRecord(stored, database),
      sessionClock,
    );
    if (observed.revision !== stored.revision) {
      database.applyActiveSessionTransition({
        session: recordFromActive(observed),
        expectedRevision: stored.revision,
        clientId: stored.controllerClientId ?? "system",
        idempotencyKey: `expiry-${stored.id}-${String(stored.revision)}`,
        requestHash: createHash("sha256")
          .update(`expiry:${stored.id}:${String(stored.revision)}`)
          .digest("base64url"),
        intervals: intervalsFromActive(observed),
        events: eventsFromActive(observed),
        now: observed.updatedAt,
      });
    }
    sendJson(response, 200, { session: activeResponse(observed) });
    return true;
  }
  if (method === "POST" && url.pathname === "/api/active-session/command") {
    const session = auth.authenticate(request, true);
    if (
      session === undefined ||
      !sameOrigin(request) ||
      !auth.csrfMatches(
        session,
        request.headers["x-csrf-token"] as string | undefined,
      )
    ) {
      sendError(
        response,
        403,
        "CSRF_REQUIRED",
        "Same-origin session and CSRF token required",
      );
      return true;
    }
    const headers = clientAuthenticationHeadersSchema.safeParse({
      clientId: request.headers["x-suite-client-id"],
      clientCredential: request.headers["x-suite-client-credential"],
    });
    if (!headers.success) {
      sendError(response, 401, "CLIENT_AUTH_REQUIRED", "Client proof required");
      return true;
    }
    const client = database.authenticateSyncClient(
      session.owner.id,
      headers.data.clientId,
      createHash("sha256")
        .update(headers.data.clientCredential)
        .digest("base64url"),
      new Date().toISOString(),
    );
    if (client === undefined) {
      sendError(
        response,
        401,
        "CLIENT_REVOKED",
        "Client proof is invalid or revoked",
      );
      return true;
    }
    const parsed = activeSessionCommandSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_ACTIVE_SESSION_COMMAND",
        "Active-session command is invalid",
      );
      return true;
    }
    const command = parsed.data;
    const commandHash = createHash("sha256")
      .update(JSON.stringify(command))
      .digest("base64url");
    const prior = database.getActiveSessionOperationOutcome(
      session.owner.id,
      client.id,
      command.idempotencyKey,
    );
    if (prior !== undefined) {
      if (prior.requestHash !== commandHash) {
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
      const opened = replayed.intervals.find(
        (interval) =>
          interval.startedAt === replayed.updatedAt &&
          interval.endedAt === null,
      );
      const closed = replayed.intervals.find(
        (interval) => interval.endedAt === replayed.updatedAt,
      );
      const interval = (value: typeof opened) =>
        value === undefined
          ? null
          : {
              id: value.id,
              sessionId: replayed.id,
              taskId: value.taskId ?? "",
              phase: value.kind,
              ordinal: value.ordinal,
              startedAt: value.startedAt,
              endedAt: value.endedAt,
            };
      sendJson(response, 200, {
        session: activeResponse(replayed),
        openedInterval: interval(opened),
        closedInterval: interval(closed),
        replayed: true,
        changeSequence: database.getSyncState(session.owner.id).cursor,
      } satisfies ActiveSessionCommandResponse);
      return true;
    }
    const before = database.getActiveSession(session.owner.id);
    const beforeSession =
      before === undefined ? undefined : activeFromRecord(before, database);
    let next: ActiveSession;
    let expected: number | null;
    if (command.command === "start") {
      if (database.getTask(session.owner.id, command.taskId) === undefined) {
        sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
        return true;
      }
      next = createActiveSession(
        {
          ownerId: session.owner.id,
          controllerClientId: client.id,
          taskId: command.taskId,
        },
        sessionClock,
        { sessionId: randomUUID(), intervalId: () => randomUUID() },
      );
      expected = null;
    } else {
      if (before?.id !== command.sessionId || beforeSession === undefined) {
        sendError(
          response,
          404,
          "ACTIVE_SESSION_NOT_FOUND",
          "Active session not found",
        );
        return true;
      }
      const transition = transitionActiveSession(
        beforeSession,
        {
          type:
            command.command === "start_break"
              ? "start-break"
              : command.command === "end_break"
                ? "end-break"
                : command.command,
          actorClientId: client.id,
          expectedRevision: command.expectedRevision,
        },
        sessionClock,
        { intervalId: () => randomUUID() },
      );
      if (!transition.ok) {
        sendError(
          response,
          transition.reason === "stale-revision" ? 412 : 409,
          "ACTIVE_SESSION_CONFLICT",
          transition.reason,
        );
        return true;
      }
      next = transition.session;
      expected = before.revision;
    }
    const transitionResult = database.applyActiveSessionTransition({
      session: recordFromActive(next),
      expectedRevision: expected,
      clientId: client.id,
      idempotencyKey: command.idempotencyKey,
      requestHash: commandHash,
      intervals: intervalsFromActive(next),
      events: eventsFromActive(next),
      now: next.updatedAt,
    });
    if (
      transitionResult.kind === "conflict" ||
      transitionResult.kind === "stale"
    ) {
      sendError(
        response,
        409,
        "ACTIVE_SESSION_CONFLICT",
        "Session changed; reload it before trying again",
      );
      return true;
    }
    const persisted =
      transitionResult.session === undefined ||
      transitionResult.intervals === undefined ||
      transitionResult.events === undefined
        ? next
        : activeFromPersistence(
            transitionResult.session,
            transitionResult.intervals,
            transitionResult.events,
          );
    const oldIntervals =
      beforeSession === undefined ? [] : beforeSession.intervals;
    const opened = persisted.intervals.find(
      (interval) => !oldIntervals.some((old) => old.id === interval.id),
    );
    const closed = persisted.intervals.find(
      (interval) =>
        oldIntervals.some(
          (old) => old.id === interval.id && old.endedAt === null,
        ) && interval.endedAt !== null,
    );
    const intervalResponse = (interval: typeof opened) =>
      interval === undefined
        ? null
        : {
            id: interval.id,
            sessionId: persisted.id,
            taskId: interval.taskId ?? "",
            phase: interval.kind,
            ordinal: interval.ordinal,
            startedAt: interval.startedAt,
            endedAt: interval.endedAt,
          };
    const body: ActiveSessionCommandResponse = {
      session: activeResponse(persisted),
      openedInterval: intervalResponse(opened),
      closedInterval: intervalResponse(closed),
      replayed: transitionResult.kind === "replayed",
      changeSequence: database.getSyncState(session.owner.id).cursor,
    };
    sendJson(response, 200, body);
    return true;
  }

  return false;
};
