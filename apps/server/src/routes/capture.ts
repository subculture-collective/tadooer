import { createHash } from "node:crypto";
import {
  capturePreferencesUpdateRequestSchema,
  capturePreviewRequestSchema,
  idempotencyKeySchema,
  taskBatchCreateRequestSchema,
  type CapturePreferencesResponse,
  type CapturePreviewItem,
  type CapturePreviewResponse,
  type CreateTaskRequest,
  type TaskBatchMutationResponse,
} from "@suite/contracts";
import { parsePastedCapture, StructuredCaptureError } from "@suite/domain";
import type { SuiteDatabase } from "@suite/persistence";
import { readJson, sameOrigin, sendError, sendJson } from "../http-utils.ts";
import {
  createCapturedTaskBatch,
  resolveTaskCapture,
} from "../task-capture.ts";
import type { RouteHandler } from "./shared.ts";
import { taskResponse } from "./shared.ts";

// Session capture endpoints (issue #90, ADR 0031): a side-effect-free preview
// of typed or pasted text, an atomic batch create for pasted lists, and the
// owner's URL behavior. Structured capture stays online-only.

const previewPath = "/api/tasks/capture-preview";
const batchPath = "/api/tasks/batch";
const preferencesPath = "/api/capture-preferences";

type PreviewChild = Omit<CapturePreviewItem, "children">;

const describeRecurrence = (
  recurrence: NonNullable<CreateTaskRequest["recurrence"]>,
): string =>
  `every ${recurrence.rule.interval === 1 ? "" : `${String(recurrence.rule.interval)} `}${
    recurrence.rule.cycle === "daily"
      ? "day"
      : recurrence.rule.cycle === "weekly"
        ? "week"
        : recurrence.rule.cycle === "monthly"
          ? "month"
          : "year"
  }${recurrence.rule.interval === 1 ? "" : "s"} from ${recurrence.startDate}${
    recurrence.startTime === null ? "" : ` at ${recurrence.startTime}`
  }`;

const previewItem = (
  database: SuiteDatabase,
  ownerId: string,
  pending: { id: string; title: string }[],
  input: CreateTaskRequest,
  now: string,
): PreviewChild => {
  const resolved = resolveTaskCapture(database, ownerId, input, now, {
    allowNewTags: true,
    pendingTags: pending,
  });
  pending.push(...(resolved.newTags ?? []));
  const projects = database.listProjects(ownerId);
  const tags = [
    ...database.listTags(ownerId),
    ...pending.map((tag) => ({ id: tag.id, title: tag.title })),
  ];
  return {
    title: resolved.title,
    notes: resolved.notes,
    estimateMinutes: resolved.estimateMinutes ?? null,
    projectTitle:
      resolved.projectId == null
        ? null
        : (projects.find((project) => project.id === resolved.projectId)
            ?.title ?? null),
    tagTitles: (resolved.tagIds ?? []).map(
      (id) => tags.find((tag) => tag.id === id)?.title ?? id,
    ),
    newTags: (resolved.newTags ?? []).map((tag) => tag.title),
    plannedDay: resolved.plannedDay ?? null,
    plannedStart: resolved.plannedStart ?? null,
    deadline: resolved.deadline?.value ?? null,
    recurrence:
      resolved.recurrence === undefined
        ? null
        : describeRecurrence(resolved.recurrence),
    links: resolved.attachments ?? [],
  };
};

export const buildCapturePreview = (
  database: SuiteDatabase,
  ownerId: string,
  text: string,
  structured: boolean,
  now: string,
): CapturePreviewResponse => {
  const pasted = parsePastedCapture(text);
  const pending: { id: string; title: string }[] = [];
  const item = (title: string, notes: string) =>
    previewItem(database, ownerId, pending, { title, notes, structured }, now);
  if (pasted.kind === "markdown") {
    const items = pasted.items.map((entry) => ({
      ...item(entry.title, entry.notes),
      children: entry.children.map((child) => item(child.title, child.notes)),
    }));
    return {
      kind: "markdown",
      items,
      newTags: [...new Set(pending.map((tag) => tag.title))],
      skippedCompleted: pasted.skippedCompleted,
      truncated: false,
      request: {
        items: pasted.items.map((entry) => ({
          title: entry.title,
          notes: entry.notes,
          structured,
          children: entry.children.map((child) => ({
            title: child.title,
            notes: child.notes,
            structured,
          })),
        })),
      },
    };
  }
  if (pasted.kind === "email") {
    // The subject is external text: markers inside it stay literal.
    const single = previewItem(
      database,
      ownerId,
      pending,
      { title: pasted.title, notes: pasted.notes, structured: false },
      now,
    );
    return {
      kind: "email",
      items: [{ ...single, children: [] }],
      newTags: [],
      skippedCompleted: 0,
      truncated: pasted.truncated,
      request: {
        items: [
          {
            title: pasted.title,
            notes: pasted.notes,
            structured: false,
            children: [],
          },
        ],
      },
    };
  }
  const line = text.replace(/\s+/g, " ").trim().slice(0, 240);
  return {
    kind: "single",
    items: [{ ...item(line, ""), children: [] }],
    newTags: [...new Set(pending.map((tag) => tag.title))],
    skippedCompleted: 0,
    truncated: line.length < text.trim().length,
    request: { items: [{ title: line, notes: "", structured, children: [] }] },
  };
};

export const handleCapture: RouteHandler = async (
  request,
  response,
  url,
  ctx,
) => {
  const { stores: database, auth } = ctx;
  const method = request.method ?? "GET";
  if (
    ![previewPath, batchPath, preferencesPath].includes(url.pathname) ||
    !["GET", "POST", "PUT"].includes(method)
  )
    return false;
  const write = method !== "GET";
  if (write && !sameOrigin(request)) {
    sendError(response, 403, "ORIGIN_REQUIRED", "Same-origin request required");
    return true;
  }
  const session = auth.authenticate(request, write);
  if (session === undefined) {
    sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
    return true;
  }
  if (
    write &&
    !auth.csrfMatches(
      session,
      request.headers["x-csrf-token"] as string | undefined,
    )
  ) {
    sendError(response, 403, "CSRF_INVALID", "Valid CSRF token required");
    return true;
  }
  const ownerId = session.owner.id;
  const now = new Date().toISOString();

  if (method === "GET" && url.pathname === preferencesPath) {
    const current = database.capture.getPreferences(ownerId);
    const body: CapturePreferencesResponse = {
      preferences: { urlBehavior: current.urlBehavior },
      revision: current.revision,
    };
    sendJson(response, 200, body);
    return true;
  }

  if (method === "PUT" && url.pathname === preferencesPath) {
    const parsed = capturePreferencesUpdateRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_PREFERENCES",
        "Capture preferences are invalid",
      );
      return true;
    }
    const updated = database.capture.updatePreferences(
      ownerId,
      parsed.data.expectedRevision,
      parsed.data.preferences,
      now,
    );
    if (updated === undefined) {
      sendError(
        response,
        412,
        "REVISION_CONFLICT",
        "Capture preferences changed; reload and try again",
      );
      return true;
    }
    const body: CapturePreferencesResponse = {
      preferences: { urlBehavior: updated.urlBehavior },
      revision: updated.revision,
    };
    sendJson(response, 200, body);
    return true;
  }

  if (method === "POST" && url.pathname === previewPath) {
    const parsed = capturePreviewRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_CAPTURE",
        "Capture preview input is invalid",
      );
      return true;
    }
    try {
      sendJson(
        response,
        200,
        buildCapturePreview(
          database,
          ownerId,
          parsed.data.text,
          parsed.data.structured,
          now,
        ),
      );
    } catch (error) {
      if (!(error instanceof StructuredCaptureError)) throw error;
      sendError(response, 400, "INVALID_TASK", error.message);
    }
    return true;
  }

  if (method === "POST" && url.pathname === batchPath) {
    const key = idempotencyKeySchema.safeParse(
      request.headers["idempotency-key"],
    );
    if (!key.success) {
      sendError(
        response,
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "A valid Idempotency-Key header is required",
      );
      return true;
    }
    const parsed = taskBatchCreateRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(response, 400, "INVALID_TASK", "Task batch input is invalid");
      return true;
    }
    const hash = createHash("sha256")
      .update(JSON.stringify(parsed.data))
      .digest("hex");
    let result;
    try {
      result = createCapturedTaskBatch(
        database,
        ownerId,
        key.data,
        hash,
        parsed.data,
        now,
      );
    } catch (error) {
      if (!(error instanceof StructuredCaptureError)) throw error;
      sendError(response, 400, "INVALID_TASK", error.message);
      return true;
    }
    if (result.kind === "conflict") {
      sendError(
        response,
        409,
        "IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used for a different request",
      );
      return true;
    }
    const body: TaskBatchMutationResponse = {
      tasks: result.tasks.map(taskResponse),
      replayed: result.kind === "replayed",
    };
    sendJson(response, result.kind === "created" ? 201 : 200, body);
    return true;
  }
  return false;
};
