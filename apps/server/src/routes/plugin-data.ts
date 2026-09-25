import type {
  PluginDataEntry,
  PluginDataListResponse,
  PluginMetadata,
} from "@suite/contracts";
import type {
  PluginDataDeleteResult,
  PluginDataEntryRecord,
  PluginMetadataRecord,
  SuiteDatabase,
} from "@suite/persistence";
import type { ServerResponse } from "node:http";
import {
  expectedRevision,
  sameOrigin,
  sendError,
  sendJson,
} from "../http-utils.ts";
import { sendEmpty, type RouteHandler } from "./shared.ts";

export const pluginDataEntryResponse = (
  entry: PluginDataEntryRecord,
): PluginDataEntry => ({
  id: entry.id,
  pluginId: entry.pluginId,
  key: entry.key,
  byteLength: entry.byteLength,
  format: entry.format,
  source: entry.source,
  revision: entry.revision,
  importedAt: entry.importedAt,
});

export const pluginMetadataResponse = (
  plugin: PluginMetadataRecord,
): PluginMetadata => ({
  id: plugin.id,
  pluginId: plugin.pluginId,
  enabled: plugin.enabled,
  source: plugin.source,
  revision: plugin.revision,
  importedAt: plugin.importedAt,
});

/** Identity, sizes and flags only; never the data (ADR 0026). */
export const pluginDataListBody = (
  database: SuiteDatabase,
  ownerId: string,
): PluginDataListResponse => {
  const { plugins, entries } = database.pluginData.list(ownerId);
  return {
    plugins: plugins.map(pluginMetadataResponse),
    entries: entries.map(pluginDataEntryResponse),
  };
};

const sendDeleted = (
  response: ServerResponse,
  result: PluginDataDeleteResult,
) => {
  if (result === "deleted") sendEmpty(response, 204);
  else if (result === "not_found")
    sendError(
      response,
      404,
      "PLUGIN_DATA_NOT_FOUND",
      "Imported plugin record not found",
    );
  else
    sendError(
      response,
      412,
      "PLUGIN_DATA_REVISION_CONFLICT",
      "The imported plugin record changed; reload before trying again",
    );
};

/**
 * Online-only imported plugin data (ADR 0026). The owner lists records,
 * reads one entry's opaque data to download it, and deletes records. There
 * is no create or edit route: records come only from an import, and nothing
 * here decodes, parses or runs plugin data.
 */
const pluginDataRoute = (
  ...[request, response, url, { auth, stores }]: Parameters<RouteHandler>
): boolean => {
  const method = request.method ?? "GET";
  const list = method === "GET" && url.pathname === "/api/plugin-data";
  const entry = /^\/api\/plugin-data\/entries\/([0-9a-f-]{36})$/.exec(
    url.pathname,
  );
  const plugin = /^\/api\/plugin-data\/plugins\/([0-9a-f-]{36})$/.exec(
    url.pathname,
  );
  const read = method === "GET" && entry !== null;
  const removeEntry = method === "DELETE" && entry !== null;
  const removePlugin = method === "DELETE" && plugin !== null;
  if (!list && !read && !removeEntry && !removePlugin) return false;
  const reading = list || read;
  const session = auth.authenticate(request, !reading);
  if (session === undefined) {
    sendError(response, 401, "AUTH_REQUIRED", "Authentication required");
    return true;
  }
  const ownerId = session.owner.id;
  if (list) {
    sendJson(response, 200, pluginDataListBody(stores, ownerId));
    return true;
  }
  if (read) {
    const found = stores.pluginData.readEntry(ownerId, entry[1] ?? "");
    if (found === undefined) {
      sendError(
        response,
        404,
        "PLUGIN_DATA_NOT_FOUND",
        "Imported plugin record not found",
      );
      return true;
    }
    sendJson(
      response,
      200,
      { entry: pluginDataEntryResponse(found.entry), data: found.data },
      { ETag: `"${String(found.entry.revision)}"` },
    );
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
  const revision = expectedRevision(request, response);
  if (revision === undefined) return true;
  sendDeleted(
    response,
    removeEntry
      ? stores.pluginData.deleteEntry(ownerId, entry[1] ?? "", revision)
      : stores.pluginData.deleteMetadata(ownerId, plugin?.[1] ?? "", revision),
  );
  return true;
};

export const handlePluginData: RouteHandler = (...args) =>
  Promise.resolve(pluginDataRoute(...args));
