import { randomUUID } from "node:crypto";
import {
  noteCreateRequestSchema,
  notePatchRequestSchema,
  organizationOrderRequestSchema,
} from "@suite/contracts";
import type { NoteMutationResult } from "@suite/persistence";
import {
  expectedRevision,
  readJson,
  sameOrigin,
  sendError,
  sendJson,
} from "../http-utils.ts";
import { noteResponse, sendEmpty, type RouteHandler } from "./shared.ts";
import type { ServerResponse } from "node:http";

const root = "/api/notes";

const sendOutcome = (
  response: ServerResponse,
  result: NoteMutationResult,
  success: () => void,
) => {
  if (result.kind === "conflict")
    sendError(
      response,
      412,
      "NOTE_REVISION_CONFLICT",
      "The note changed; reload before trying again",
    );
  else if (result.kind === "invalid")
    sendError(
      response,
      400,
      "INVALID_NOTE",
      "Provide note content and at most one project or tag you own",
    );
  else success();
};

/**
 * Online-only owner notes (ADR 0019). Notes are not in the sync change feed;
 * browsers read them over HTTP and do not cache them offline.
 */
export const handleNotes: RouteHandler = async (
  request,
  response,
  url,
  { auth, stores },
) => {
  const method = request.method ?? "GET";
  const match = /^\/api\/notes\/([0-9a-f-]{36})$/.exec(url.pathname);
  const list = method === "GET" && url.pathname === root;
  const create = method === "POST" && url.pathname === root;
  const order = method === "PUT" && url.pathname === `${root}/order`;
  const patch = method === "PATCH" && match !== null;
  const remove = method === "DELETE" && match !== null;
  if (!list && !create && !order && !patch && !remove) return false;
  const session = auth.authenticate(request, !list);
  if (session === undefined) {
    sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
    return true;
  }
  const ownerId = session.owner.id;
  if (list) {
    sendJson(response, 200, {
      notes: stores.notes.list(ownerId).map(noteResponse),
    });
    return true;
  }
  if (
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
  const now = new Date().toISOString();
  if (create) {
    const parsed = noteCreateRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      sendError(response, 400, "INVALID_NOTE", "Note content is invalid");
      return true;
    }
    const result = stores.notes.create(
      ownerId,
      { id: randomUUID(), ...parsed.data },
      now,
    );
    sendOutcome(response, result, () => {
      const note = result.kind === "applied" ? result.notes[0] : undefined;
      if (note === undefined) throw new Error("Created note missing");
      sendJson(
        response,
        201,
        { note: noteResponse(note) },
        { ETag: `"${String(note.revision)}"` },
      );
    });
    return true;
  }
  if (order) {
    const parsed = organizationOrderRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_NOTE_ORDER",
        "Provide every note once with its current revision",
      );
      return true;
    }
    const result = stores.notes.reorder(ownerId, parsed.data.items, now);
    sendOutcome(response, result, () => {
      sendJson(response, 200, {
        notes: result.kind === "applied" ? result.notes.map(noteResponse) : [],
      });
    });
    return true;
  }
  const id = match?.[1];
  const revision = expectedRevision(request, response);
  if (revision === undefined || id === undefined) return true;
  if (remove) {
    const result = stores.notes.delete(ownerId, id, revision);
    sendOutcome(response, result, () => {
      sendEmpty(response, 204);
    });
    return true;
  }
  const parsed = notePatchRequestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    sendError(response, 400, "INVALID_NOTE", "Note edit is invalid");
    return true;
  }
  const result = stores.notes.update(ownerId, id, revision, parsed.data, now);
  sendOutcome(response, result, () => {
    const note = result.kind === "applied" ? result.notes[0] : undefined;
    if (note === undefined) throw new Error("Updated note missing");
    sendJson(
      response,
      200,
      { note: noteResponse(note) },
      { ETag: `"${String(note.revision)}"` },
    );
  });
  return true;
};
