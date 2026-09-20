import {
  randomUUID,
  randomBytes,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import {
  calendarImportPreviewRequestSchema,
  calendarImportReportSchema,
  calendarFeedCreateRequestSchema,
} from "@suite/contracts";
import { parseIcsImport, serializeCalendarFeed } from "@suite/import-export";
import {
  sendJson,
  sendError,
  readJson,
  sameOrigin,
  securityHeaders,
} from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";

export const handleCalendar: RouteHandler = async (
  request,
  response,
  url,
  ctx,
) => {
  const { stores: database, auth, baikal: connector } = ctx;
  const method = request.method ?? "GET";
  const timestamp = new Date().toISOString();

  const publicFeedMatch =
    /^\/feeds\/([0-9a-f-]{36})\/([A-Za-z0-9_-]{43})\.ics$/.exec(url.pathname);
  if (publicFeedMatch !== null) {
    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(405, {
        ...securityHeaders,
        Allow: "GET, HEAD",
        "Cache-Control": "private, no-store",
      });
      response.end();
      return true;
    }
    const capability = database.getCalendarFeedCapability(
      publicFeedMatch[1] ?? "",
    );
    const supplied = createHash("sha256")
      .update(publicFeedMatch[2] ?? "")
      .digest();
    const expected =
      capability === undefined
        ? Buffer.alloc(32)
        : Buffer.from(capability.secretHash, "base64url");
    if (
      capability?.revokedAt !== null ||
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    ) {
      sendError(
        response,
        404,
        "FEED_NOT_FOUND",
        "Calendar feed is unavailable",
      );
      return true;
    }
    const feed = serializeCalendarFeed(
      database.listPublishedCalendarRaw(
        capability.ownerId,
        capability.calendarId,
      ),
    );
    response.writeHead(200, {
      ...securityHeaders,
      "Cache-Control": "private, no-store",
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="suite-read-only.ics"',
      Allow: "GET, HEAD",
    });
    response.end(method === "HEAD" ? undefined : feed);
    return true;
  }

  if (method === "POST" && url.pathname === "/api/imports/preview") {
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
    const parsed = calendarImportPreviewRequestSchema.safeParse(
      await readJson(request),
    );
    if (!parsed.success) {
      sendError(
        response,
        400,
        "INVALID_IMPORT",
        "Calendar import input is invalid",
      );
      return true;
    }
    const report = parseIcsImport(parsed.data.source, parsed.data.rawIcs);
    const jobId = randomUUID();
    const result = database.createCalendarImportPreview({
      id: jobId,
      ownerId: session.owner.id,
      calendarId: parsed.data.calendarId,
      source: parsed.data.source,
      inputHash: report.inputHash,
      report,
      candidates: report.candidates.map((candidate) => ({
        externalId: candidate.externalId,
        uid: candidate.uid,
        rawIcs: candidate.rawIcs,
        href: `${createHash("sha256").update(`${parsed.data.calendarId}\0${candidate.externalId}`).digest("hex").slice(0, 40)}.ics`,
      })),
      createdAt: timestamp,
    });
    if (result === undefined) {
      sendError(
        response,
        404,
        "CALENDAR_NOT_FOUND",
        "Destination calendar not found",
      );
      return true;
    }
    sendJson(response, result.replayed ? 200 : 201, {
      job: {
        ...result.job,
        report: calendarImportReportSchema.parse(result.job.report),
        items: result.job.items.map((item) => ({
          externalId: item.externalId,
          uid: item.uid,
          href: item.href,
          state: item.state,
          appliedAt: item.appliedAt,
        })),
      },
      replayed: result.replayed,
    });
    return true;
  }

  const importMatch = /^\/api\/imports\/([0-9a-f-]{36})(?:\/(apply))?$/.exec(
    url.pathname,
  );
  if (importMatch !== null) {
    const session = auth.authenticate(request, method === "POST");
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Owner session required");
      return true;
    }
    if (method === "GET" && importMatch[2] === undefined) {
      const job = database.getCalendarImportJob(
        session.owner.id,
        importMatch[1] ?? "",
      );
      if (job === undefined)
        sendError(
          response,
          404,
          "IMPORT_NOT_FOUND",
          "Calendar import not found",
        );
      else
        sendJson(response, 200, {
          job: {
            ...job,
            report: calendarImportReportSchema.parse(job.report),
            items: job.items.map((item) => ({
              externalId: item.externalId,
              uid: item.uid,
              href: item.href,
              state: item.state,
              appliedAt: item.appliedAt,
            })),
          },
          replayed: job.state !== "previewed",
        });
      return true;
    }
    if (method === "POST" && importMatch[2] === "apply") {
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
      const job = database.getCalendarImportJob(
        session.owner.id,
        importMatch[1] ?? "",
      );
      if (job === undefined) {
        sendError(
          response,
          404,
          "IMPORT_NOT_FOUND",
          "Calendar import not found",
        );
        return true;
      }
      const replayed = job.state === "applied";
      if (!replayed) {
        for (const item of job.items) {
          if (item.state === "applied") continue;
          const write = await connector.putImportedEvent({
            ownerId: session.owner.id,
            calendarId: job.calendarId,
            href: item.href,
            rawIcs: item.rawIcs,
          });
          database.markCalendarImportItem(
            session.owner.id,
            job.id,
            item.externalId,
            write.ok || write.reason === "precondition-failed"
              ? "applied"
              : "reconciliation_required",
            timestamp,
          );
        }
      }
      const completed = database.finishCalendarImport(
        session.owner.id,
        job.id,
        timestamp,
      );
      if (completed === undefined)
        throw new Error("Calendar import disappeared");
      sendJson(response, 200, {
        job: {
          ...completed,
          report: calendarImportReportSchema.parse(completed.report),
          items: completed.items.map((item) => ({
            externalId: item.externalId,
            uid: item.uid,
            href: item.href,
            state: item.state,
            appliedAt: item.appliedAt,
          })),
        },
        replayed,
      });
      return true;
    }
    sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed");
    return true;
  }

  const exportMatch = /^\/api\/calendars\/([0-9a-f-]{36})\/export\.ics$/.exec(
    url.pathname,
  );
  if (method === "GET" && exportMatch !== null) {
    const session = auth.authenticate(request, false);
    const calendarId = exportMatch[1] ?? "";
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Owner session required");
      return true;
    }
    if (database.getOwnedCalendar(session.owner.id, calendarId) === undefined) {
      sendError(response, 404, "CALENDAR_NOT_FOUND", "Calendar not found");
      return true;
    }
    const feed = serializeCalendarFeed(
      database.listPublishedCalendarRaw(session.owner.id, calendarId),
    );
    response.writeHead(200, {
      ...securityHeaders,
      "Cache-Control": "no-store",
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="suite-calendar.ics"',
    });
    response.end(feed);
    return true;
  }

  if (url.pathname === "/api/calendar-feeds") {
    const session = auth.authenticate(request, method === "POST");
    if (session === undefined) {
      sendError(response, 401, "AUTH_REQUIRED", "Owner session required");
      return true;
    }
    if (method === "GET") {
      sendJson(response, 200, {
        capabilities: database
          .listCalendarFeedCapabilities(session.owner.id)
          .map((record) => ({
            id: record.id,
            calendarId: record.calendarId,
            label: record.label,
            createdAt: record.createdAt,
            revokedAt: record.revokedAt,
          })),
      });
      return true;
    }
    if (method === "POST") {
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
      const parsed = calendarFeedCreateRequestSchema.safeParse(
        await readJson(request),
      );
      if (
        !parsed.success ||
        database.getOwnedCalendar(session.owner.id, parsed.data.calendarId) ===
          undefined
      ) {
        sendError(
          response,
          400,
          "INVALID_FEED",
          "Read-only feed input is invalid",
        );
        return true;
      }
      const id = randomUUID();
      const secret = randomBytes(32).toString("base64url");
      const record = {
        id,
        ownerId: session.owner.id,
        calendarId: parsed.data.calendarId,
        label: parsed.data.label,
        secretHash: createHash("sha256").update(secret).digest("base64url"),
        createdAt: timestamp,
        revokedAt: null,
      };
      database.createCalendarFeedCapability(record);
      const capability = {
        id: record.id,
        calendarId: record.calendarId,
        label: record.label,
        createdAt: record.createdAt,
        revokedAt: record.revokedAt,
      };
      sendJson(response, 201, {
        capability,
        url: `/feeds/${id}/${secret}.ics`,
      });
      return true;
    }
  }
  const feedRevokeMatch = /^\/api\/calendar-feeds\/([0-9a-f-]{36})$/.exec(
    url.pathname,
  );
  if (method === "DELETE" && feedRevokeMatch !== null) {
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
    if (
      !database.revokeCalendarFeedCapability(
        session.owner.id,
        feedRevokeMatch[1] ?? "",
        timestamp,
      )
    )
      sendError(response, 404, "FEED_NOT_FOUND", "Calendar feed not found");
    else {
      response.writeHead(204, {
        ...securityHeaders,
        "Cache-Control": "no-store",
      });
      response.end();
    }
    return true;
  }

  return false;
};
