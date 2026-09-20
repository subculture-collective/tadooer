import { randomUUID, createHash, randomBytes } from "node:crypto";
import type {
  ClientRegistrationResponse,
  SyncRoundResponse,
  SyncSnapshotResponse,
} from "@suite/contracts";
import {
  clientRegistrationRequestSchema,
  clientAuthenticationHeadersSchema,
  syncRoundRequestSchema,
} from "@suite/contracts";
import { sendJson, sendError, readJson, sameOrigin } from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";
import {
  cursorFor,
  parseCursor,
  sendEmpty,
  taskResponse,
  projectResponse,
  tagResponse,
  subtaskResponse,
  templateResponse,
  templateBlueprintResponse,
  templateSetResponse,
  choicePoolResponse,
  choicePoolItemResponse,
  choicePoolHistoryResponse,
  planningPlaceholderResponse,
  planningResolutionResponse,
  activeFromRecord,
  activeResponse,
} from "./shared.ts";

export const handleSync: RouteHandler = async (request, response, url, ctx) => {
  const { stores: database, auth } = ctx;
  const method = request.method ?? "GET";

  if (method === "POST" && url.pathname === "/api/clients") {
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
    const parsed = clientRegistrationRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(response, 400, "INVALID_CLIENT", "Client input is invalid");
      return true;
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    const credential = randomBytes(32).toString("base64url");
    database.registerSyncClient({
      id,
      ownerId: session.owner.id,
      label: parsed.data.label,
      credentialHash: createHash("sha256")
        .update(credential)
        .digest("base64url"),
      createdAt: now,
      lastSeenAt: now,
      revokedAt: null,
    });
    const state = database.getSyncState(session.owner.id);
    const body: ClientRegistrationResponse = {
      client: {
        id,
        ownerId: session.owner.id,
        label: parsed.data.label,
        createdAt: now,
        lastSeenAt: now,
        revokedAt: null,
      },
      clientCredential: credential,
      initialCursor: cursorFor(state),
    };
    sendJson(response, 201, body);
    return true;
  }

  if (method === "GET" && url.pathname === "/api/clients") {
    const session = auth.authenticate(request, false);
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
      return true;
    }
    // Credentials are deliberately never returned from this inventory.
    const clients = database
      .listSyncClients(session.owner.id)
      .map(({ id, ownerId, label, createdAt, lastSeenAt, revokedAt }) => ({
        id,
        ownerId,
        label,
        createdAt,
        lastSeenAt,
        revokedAt,
      }));
    sendJson(response, 200, { clients });
    return true;
  }

  const revokeMatch = /^\/api\/clients\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (method === "DELETE" && revokeMatch !== null) {
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
    const clientId = revokeMatch[1];
    if (clientId === undefined) {
      sendError(response, 404, "CLIENT_NOT_FOUND", "Client not found");
      return true;
    }
    if (
      !database.revokeSyncClient(
        session.owner.id,
        clientId,
        new Date().toISOString(),
      )
    ) {
      sendError(response, 404, "CLIENT_NOT_FOUND", "Client not found");
      return true;
    }
    sendEmpty(response, 204);
    return true;
  }

  if (
    (method === "POST" && url.pathname === "/api/sync/round") ||
    (method === "GET" && url.pathname === "/api/sync/snapshot")
  ) {
    const session = auth.authenticate(request, method === "POST");
    if (
      session === undefined ||
      (method === "POST" &&
        (!sameOrigin(request) ||
          !auth.csrfMatches(
            session,
            request.headers["x-csrf-token"] as string | undefined,
          )))
    ) {
      sendError(
        response,
        method === "POST" ? 403 : 401,
        method === "POST" ? "CSRF_REQUIRED" : "AUTH_REQUIRED",
        "Authenticated same-origin request required",
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
    if (request.headers["x-suite-sync-version"] !== "2") {
      sendError(
        response,
        426,
        "SYNC_PROTOCOL_UPGRADE_REQUIRED",
        "Sync protocol version 2 is required",
      );
      return true;
    }
    if (method === "GET") {
      const snapshot = database.fullSyncSnapshot(session.owner.id);
      const allSnapshots = [
        ...snapshot.tasks.map((task) => ({
          entityKind: "task" as const,
          value: {
            task: taskResponse(task),
            fieldVersions: (() => {
              const versions = database.getTaskFieldVersions(
                session.owner.id,
                task.id,
              );
              return {
                title: versions.title ?? task.revision,
                notes: versions.notes ?? task.revision,
                status: versions.status ?? task.revision,
                estimateMinutes: versions.estimateMinutes ?? task.revision,
                projectId: versions.projectId ?? task.revision,
                tagIds: versions.tagIds ?? task.revision,
                deadline: versions.deadline ?? task.revision,
              };
            })(),
            changeSequence: task.revision,
          },
        })),
        ...snapshot.projects.map((project) => ({
          entityKind: "project" as const,
          value: projectResponse(project),
        })),
        ...snapshot.tags.map((tag) => ({
          entityKind: "tag" as const,
          value: tagResponse(tag),
        })),
        ...snapshot.subtasks.map((subtask) => ({
          entityKind: "subtask" as const,
          value: subtaskResponse(subtask),
        })),
        ...snapshot.templates.map((template) => ({
          entityKind: "template" as const,
          value: {
            template: templateResponse(template),
            blueprints: database
              .listTemplateSubtaskBlueprints(template.id)
              .map(templateBlueprintResponse),
            poolSlots: [...database.listTemplatePoolSlots(template.id)],
          },
        })),
        ...snapshot.templateSets.map((set) => ({
          entityKind: "template_set" as const,
          value: {
            set: templateSetResponse(set),
            members: [...database.listTemplateSetMembers(set.id)],
          },
        })),
        ...database.listChoicePools(session.owner.id, true).map((pool) => ({
          entityKind: "choice_pool" as const,
          value: {
            pool: choicePoolResponse(pool),
            items: database
              .listChoicePoolItems(pool.id, true)
              .map(choicePoolItemResponse),
            history: database
              .listChoicePoolHistory(pool.id)
              .map(choicePoolHistoryResponse),
          },
        })),
        ...database
          .listPlanningPlaceholders(session.owner.id)
          .map((placeholder) => ({
            entityKind: "planning_placeholder" as const,
            value: {
              placeholder: planningPlaceholderResponse(placeholder),
              resolution: (() => {
                const resolution = database.getPlanningPlaceholderResolution(
                  placeholder.id,
                );
                return resolution === undefined
                  ? null
                  : planningResolutionResponse(resolution);
              })(),
            },
          })),
      ];
      const offset = Number(url.searchParams.get("offset") ?? "0");
      if (!Number.isInteger(offset) || offset < 0) {
        sendError(
          response,
          400,
          "INVALID_SNAPSHOT_OFFSET",
          "Snapshot offset is invalid",
        );
        return true;
      }
      const snapshots = allSnapshots.slice(offset, offset + 200);
      const body: SyncSnapshotResponse = {
        snapshots,
        nextCursor: cursorFor(snapshot.cursor),
        hasMore: offset + snapshots.length < allSnapshots.length,
        serverTimestamp: new Date().toISOString(),
      };
      sendJson(response, 200, body);
      return true;
    }
    const parsed = syncRoundRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_SYNC_OPERATION",
        "Sync round is invalid",
      );
      return true;
    }
    const cursor =
      parsed.data.cursor === null ? undefined : parseCursor(parsed.data.cursor);
    const initialPage =
      cursor === undefined && parsed.data.cursor !== null
        ? {
            resetRequired: true,
            changes: [],
            cursor: database.getSyncState(session.owner.id).cursor,
          }
        : database.pageSyncChanges(
            session.owner.id,
            cursor?.epoch ?? database.getSyncState(session.owner.id).epoch,
            cursor?.sequence ?? 0,
            parsed.data.pullLimit,
          );
    if (initialPage.resetRequired) {
      sendJson(response, 409, {
        code: "SYNC_CURSOR_EXPIRED",
        message: "Sync cursor expired",
        requestId: randomUUID(),
        action: "replace_cache_from_snapshot",
      });
      return true;
    }
    const outcomes = parsed.data.operations.map((operation) => {
      const now = new Date().toISOString();
      const result =
        operation.kind === "task.create"
          ? database.applyTaskCreateSync({
              ownerId: session.owner.id,
              clientId: client.id,
              operationId: operation.operationId,
              requestHash: operation.requestHash,
              now,
              task: {
                ...operation.task,
                deadline: operation.task.deadline ?? null,
                status: "open",
                revision: 1,
                createdAt: now,
                updatedAt: now,
              },
            })
          : operation.kind === "task.patch"
            ? database.applyTaskFieldSync({
                ownerId: session.owner.id,
                clientId: client.id,
                operationId: operation.operationId,
                requestHash: operation.requestHash,
                taskId: operation.taskId,
                baseVersions: Object.fromEntries(
                  Object.entries(operation.baseFieldVersions).filter(
                    ([, value]) => value !== undefined,
                  ),
                ),
                patch: Object.fromEntries(
                  Object.entries(operation.fields).filter(
                    ([, value]) => value !== undefined,
                  ),
                ),
                now,
              })
            : operation.kind === "task.complete" ||
                operation.kind === "task.reopen"
              ? database.applyTaskCompletionSync({
                  ownerId: session.owner.id,
                  clientId: client.id,
                  operationId: operation.operationId,
                  requestHash: operation.requestHash,
                  taskId: operation.taskId,
                  baseStatusVersion: operation.baseStatusVersion,
                  completed: operation.kind === "task.complete",
                  now,
                })
              : database.applyTaskDeletionSync({
                  ownerId: session.owner.id,
                  clientId: client.id,
                  operationId: operation.operationId,
                  requestHash: operation.requestHash,
                  taskId: operation.taskId,
                  baseRevision: (
                    operation as Extract<
                      typeof operation,
                      { readonly kind: "task.delete" | "task.restore" }
                    >
                  ).baseRevision,
                  restore: operation.kind === "task.restore",
                  now,
                });
      if (result.kind === "idempotency-conflict") {
        return {
          kind: "rejected" as const,
          operationId: operation.operationId,
          code: "IDEMPOTENCY_CONFLICT" as const,
        };
      }
      if (result.kind === "conflict") {
        const conflictFields =
          "fields" in result && Array.isArray(result.fields)
            ? result.fields.filter(
                (
                  field,
                ): field is
                  | "title"
                  | "notes"
                  | "status"
                  | "estimateMinutes"
                  | "projectId"
                  | "tagIds" =>
                  [
                    "title",
                    "notes",
                    "status",
                    "estimateMinutes",
                    "projectId",
                    "tagIds",
                    "deadline",
                  ].includes(String(field)),
              )
            : undefined;
        return {
          kind: "conflict" as const,
          operationId: operation.operationId,
          code:
            conflictFields === undefined || conflictFields.length === 0
              ? ("SYNC_RESOURCE_CONFLICT" as const)
              : ("SYNC_FIELD_CONFLICT" as const),
          taskId:
            operation.kind === "task.create"
              ? operation.task.id
              : operation.taskId,
          taskRevision: result.task?.revision ?? 1,
          ...(conflictFields === undefined || conflictFields.length === 0
            ? {}
            : { conflictingFields: conflictFields }),
        };
      }
      const task = result.task;
      if (task === undefined)
        return {
          kind: "rejected" as const,
          operationId: operation.operationId,
          code: "IDEMPOTENCY_CONFLICT" as const,
        };
      return {
        kind: result.kind,
        operationId: operation.operationId,
        entityId: task.id,
        entityRevision: task.revision,
        changeSequence: database.getSyncState(session.owner.id).cursor,
      };
    });
    const page = database.pageSyncChanges(
      session.owner.id,
      cursor?.epoch ?? database.getSyncState(session.owner.id).epoch,
      cursor?.sequence ?? 0,
      parsed.data.pullLimit,
    );
    const body: SyncRoundResponse = {
      outcomes,
      changes: page.changes.map((change) => {
        const task =
          change.entityType === "task"
            ? database.getTask(session.owner.id, change.entityId, true)
            : undefined;
        const versions =
          task === undefined
            ? undefined
            : database.getTaskFieldVersions(session.owner.id, task.id);
        const active =
          change.entityType === "active_session"
            ? database.getActiveSession(session.owner.id)
            : undefined;
        const project =
          change.entityType === "project"
            ? database
                .listProjects(session.owner.id)
                .find(({ id }) => id === change.entityId)
            : undefined;
        const tag =
          change.entityType === "tag"
            ? database
                .listTags(session.owner.id)
                .find(({ id }) => id === change.entityId)
            : undefined;
        const subtask =
          change.entityType === "subtask"
            ? database
                .fullSyncSnapshot(session.owner.id)
                .subtasks.find(({ id }) => id === change.entityId)
            : undefined;
        const template =
          change.entityType === "template"
            ? database.getTaskTemplate(session.owner.id, change.entityId, true)
            : undefined;
        const templateSet =
          change.entityType === "template_set"
            ? database
                .listTemplateSets(session.owner.id, true)
                .find(({ id }) => id === change.entityId)
            : undefined;
        const choicePool =
          change.entityType === "choice_pool"
            ? database.getChoicePool(session.owner.id, change.entityId, true)
            : undefined;
        const planningPlaceholder =
          change.entityType === "planning_placeholder"
            ? database.getPlanningPlaceholder(session.owner.id, change.entityId)
            : undefined;
        return {
          sequence: change.sequence,
          entityKind: change.entityType as
            | "task"
            | "project"
            | "tag"
            | "subtask"
            | "template"
            | "template_set"
            | "choice_pool"
            | "planning_placeholder"
            | "active_session",
          entityId: change.entityId,
          kind:
            change.kind === "deleted"
              ? ("deleted" as const)
              : change.kind === "session_changed"
                ? ("session_changed" as const)
                : ("upsert" as const),
          entityRevision: change.revision,
          changedAt: change.createdAt,
          snapshot:
            task !== undefined && versions !== undefined
              ? {
                  entityKind: "task" as const,
                  value: {
                    task: taskResponse(task),
                    fieldVersions: {
                      title: versions.title ?? task.revision,
                      notes: versions.notes ?? task.revision,
                      status: versions.status ?? task.revision,
                      estimateMinutes:
                        versions.estimateMinutes ?? task.revision,
                      projectId: versions.projectId ?? task.revision,
                      tagIds: versions.tagIds ?? task.revision,
                      deadline: versions.deadline ?? task.revision,
                    },
                    changeSequence: change.sequence,
                  },
                }
              : project !== undefined
                ? {
                    entityKind: "project" as const,
                    value: projectResponse(project),
                  }
                : tag !== undefined
                  ? {
                      entityKind: "tag" as const,
                      value: tagResponse(tag),
                    }
                  : subtask !== undefined
                    ? {
                        entityKind: "subtask" as const,
                        value: subtaskResponse(subtask),
                      }
                    : template !== undefined
                      ? {
                          entityKind: "template" as const,
                          value: {
                            template: templateResponse(template),
                            blueprints: database
                              .listTemplateSubtaskBlueprints(template.id)
                              .map(templateBlueprintResponse),
                            poolSlots: [
                              ...database.listTemplatePoolSlots(template.id),
                            ],
                          },
                        }
                      : templateSet !== undefined
                        ? {
                            entityKind: "template_set" as const,
                            value: {
                              set: templateSetResponse(templateSet),
                              members: [
                                ...database.listTemplateSetMembers(
                                  templateSet.id,
                                ),
                              ],
                            },
                          }
                        : choicePool !== undefined
                          ? {
                              entityKind: "choice_pool" as const,
                              value: {
                                pool: choicePoolResponse(choicePool),
                                items: database
                                  .listChoicePoolItems(choicePool.id, true)
                                  .map(choicePoolItemResponse),
                                history: database
                                  .listChoicePoolHistory(choicePool.id)
                                  .map(choicePoolHistoryResponse),
                              },
                            }
                          : planningPlaceholder !== undefined
                            ? {
                                entityKind: "planning_placeholder" as const,
                                value: {
                                  placeholder:
                                    planningPlaceholderResponse(
                                      planningPlaceholder,
                                    ),
                                  resolution: (() => {
                                    const resolution =
                                      database.getPlanningPlaceholderResolution(
                                        planningPlaceholder.id,
                                      );
                                    return resolution === undefined
                                      ? null
                                      : planningResolutionResponse(resolution);
                                  })(),
                                },
                              }
                            : active?.id === change.entityId
                              ? {
                                  entityKind: "active_session" as const,
                                  value: activeResponse(
                                    activeFromRecord(active, database),
                                  ),
                                }
                              : null,
        };
      }),
      nextCursor: cursorFor({
        epoch: database.getSyncState(session.owner.id).epoch,
        cursor: page.cursor,
      }),
      hasMore: page.changes.length === parsed.data.pullLimit,
      serverTimestamp: new Date().toISOString(),
    };
    sendJson(response, 200, body);
    return true;
  }

  return false;
};
