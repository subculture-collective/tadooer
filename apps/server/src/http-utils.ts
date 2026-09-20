import { randomUUID } from "node:crypto";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import type {
  ApiError,
  ConditionalTaskMutationResponse,
} from "@suite/contracts";
import { conditionalRequestHeadersSchema } from "@suite/contracts";
import type { ConditionalTaskResult } from "@suite/persistence";
import { taskResponse } from "./routes/shared.ts";

export const mimeTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

export const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
} as const;

export const maxJsonBytes = 5 * 1024 * 1024;

export const sendJson = (
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void => {
  response.writeHead(status, {
    ...securityHeaders,
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(body));
};

export const sendError = (
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
): void => {
  const body: ApiError = { code, message, requestId: randomUUID() };
  sendJson(response, status, body);
};

export const expectedRevision = (
  request: IncomingMessage,
  response: ServerResponse,
): number | undefined => {
  const header = request.headers["if-match"];
  if (header === undefined) {
    sendError(
      response,
      428,
      "PRECONDITION_REQUIRED",
      "A current task If-Match header is required",
    );
    return undefined;
  }
  const parsed = conditionalRequestHeadersSchema.safeParse({ ifMatch: header });
  if (!parsed.success) {
    sendError(
      response,
      400,
      "INVALID_PRECONDITION",
      "The task If-Match header is invalid",
    );
    return undefined;
  }
  return Number(parsed.data.ifMatch.slice(1, -1));
};

export const sendConditionalTask = (
  response: ServerResponse,
  result: ConditionalTaskResult,
): void => {
  if (result.kind === "not-found") {
    sendError(response, 404, "TASK_NOT_FOUND", "Task not found");
    return;
  }
  if (result.kind === "precondition-failed") {
    sendError(
      response,
      412,
      "TASK_REVISION_CONFLICT",
      "The task changed; reload it before trying again",
    );
    return;
  }
  const body: ConditionalTaskMutationResponse = {
    task: taskResponse(result.task),
  };
  sendJson(response, 200, body, {
    ETag: `"${String(result.task.revision)}"`,
  });
};

export const sameOrigin = (request: IncomingMessage): boolean => {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin === undefined || host === undefined) return false;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.host === host &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
};

export const normalizedAddress = (value: string): string =>
  value.startsWith("::ffff:") ? value.slice(7) : value;

export const clientAddress = (
  request: IncomingMessage,
  trustedProxyCidrs: readonly string[],
): string => {
  const remote = normalizedAddress(request.socket.remoteAddress ?? "unknown");
  const trusted = trustedProxyCidrs.some((cidr) => {
    const [address, prefix] = cidr.split("/");
    return (
      address !== undefined &&
      ((prefix === "32" && normalizedAddress(address) === remote) ||
        (prefix === "128" && address === remote))
    );
  });
  if (!trusted) return remote;
  const forwarded = request.headers["x-forwarded-for"];
  if (
    typeof forwarded !== "string" ||
    forwarded.includes(",") ||
    isIP(forwarded.trim()) === 0
  )
    return remote;
  return normalizedAddress(forwarded.trim());
};

export const readJson = async (
  request: IncomingMessage,
  byteLimit = maxJsonBytes,
): Promise<unknown> => {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") throw new Error("CONTENT_TYPE");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > byteLimit) {
      request.resume();
      throw new Error("BODY_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("INVALID_JSON");
  }
};
