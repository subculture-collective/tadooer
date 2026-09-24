import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, join, normalize } from "node:path";
import { existsSync, statSync } from "node:fs";
import { sendError, securityHeaders } from "../http-utils.ts";
import type { RouteHandler } from "./shared.ts";
import { isInside, serveFile, sendEmpty } from "./shared.ts";

export const handleStatic: RouteHandler = async (
  request,
  response,
  url,
  ctx,
) => {
  await Promise.resolve();
  const { config } = ctx;
  const method = request.method ?? "GET";
  const webRoot = resolve(config.webRoot);

  // API path: already handled by other route modules, skip
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/feeds/"))
    return false;

  if (method !== "GET" && method !== "HEAD") {
    sendEmpty(response, 405);
    return true;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendEmpty(response, 400);
    return true;
  }

  const requested = resolve(webRoot, `.${normalize(pathname)}`);
  const file =
    isInside(webRoot, requested) &&
    existsSync(requested) &&
    statSync(requested).isFile()
      ? requested
      : join(webRoot, "index.html");

  if (!isInside(webRoot, file) || !existsSync(file)) {
    sendError(response, 404, "WEB_BUILD_NOT_FOUND", "Web build not found");
    return true;
  }

  if (file === join(webRoot, "index.html")) {
    const nonce = randomBytes(24).toString("base64");
    const html = await readFile(file, "utf8");
    const meta = `<meta name="style-nonce" content="${nonce}">`;
    const body = html.includes("<head>")
      ? html.replace("<head>", `<head>${meta}`)
      : `${meta}${html}`;
    response.writeHead(200, {
      ...securityHeaders,
      "Content-Security-Policy": securityHeaders[
        "Content-Security-Policy"
      ].replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`),
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(method === "HEAD" ? undefined : body);
    return true;
  }

  if (method === "HEAD") {
    response.writeHead(200, securityHeaders);
    response.end();
    return true;
  }
  serveFile(response, file);
  return true;
};
