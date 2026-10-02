import { z } from "zod";

/**
 * Live sync event stream (ADR 0045). `GET /api/sync/events` is a
 * `text/event-stream` response read with `fetch`, authenticated like a sync
 * round (session cookie plus the client proof headers). Events are hints:
 * they say that something changed, never what. A client that misses every
 * event still converges through ordinary sync rounds and refetches.
 */
export const liveSyncPath = "/api/sync/events";

/** Seconds between `: hb` comment lines; below common proxy idle timeouts. */
export const liveSyncHeartbeatSeconds = 25;

/**
 * Owner records that are outside the sync feed (ADR 0033 boundaries). A
 * `resources` event names the families whose online views should be refetched.
 * `all` follows a restore, import or other wholesale change.
 */
export const liveSyncResourceFamilies = [
  "all",
  "notes",
  "task_links",
  "task_planning",
  "archive",
  "recurrence",
  "time_entries",
  "counters",
  "evaluations",
  "plugin_data",
  "day_orders",
  "boards",
  "organization",
  "focus",
  "application_preferences",
  "planning_preferences",
  "notification_preferences",
  "capture_preferences",
  "calendar",
  "calendar_subscriptions",
  "calendar_bridge",
  "connectors",
  "publication",
  "automation",
] as const;
export const liveSyncResourceFamilySchema = z.enum(liveSyncResourceFamilies);
export type LiveSyncResourceFamily = z.infer<
  typeof liveSyncResourceFamilySchema
>;

const cursor = z.string().min(1).max(512);

/** First event on every stream. `head` is the feed position at connect time. */
export const liveSyncHelloEventSchema = z
  .object({
    protocolVersion: z.literal(2),
    head: cursor,
    heartbeatSeconds: z.number().int().positive(),
    serverTimestamp: z.iso.datetime(),
  })
  .strict();

/** The sync feed advanced to `head`; run a round if the local cursor differs. */
export const liveSyncChangesEventSchema = z.object({ head: cursor }).strict();

/**
 * Records outside the feed changed. `sourceClientId` is the registered client
 * whose request caused it (null for server ticks, automation tokens and other
 * processes), so that client can skip a refetch of what it just wrote.
 */
export const liveSyncResourcesEventSchema = z
  .object({
    families: z.array(liveSyncResourceFamilySchema).min(1).max(24),
    sourceClientId: z.uuid().nullable(),
  })
  .strict();

/** Last event before the server closes the stream on purpose. */
export const liveSyncByeEventSchema = z
  .object({
    reason: z.enum([
      "shutdown",
      "session-ended",
      "client-revoked",
      "replaced",
      "epoch-reset",
    ]),
  })
  .strict();

export const liveSyncEventNames = [
  "hello",
  "changes",
  "resources",
  "bye",
] as const;
export type LiveSyncEventName = (typeof liveSyncEventNames)[number];

export type LiveSyncHelloEvent = z.infer<typeof liveSyncHelloEventSchema>;
export type LiveSyncChangesEvent = z.infer<typeof liveSyncChangesEventSchema>;
export type LiveSyncResourcesEvent = z.infer<
  typeof liveSyncResourcesEventSchema
>;
export type LiveSyncByeEvent = z.infer<typeof liveSyncByeEventSchema>;

export type LiveSyncEvent =
  | { readonly event: "hello"; readonly data: LiveSyncHelloEvent }
  | { readonly event: "changes"; readonly data: LiveSyncChangesEvent }
  | { readonly event: "resources"; readonly data: LiveSyncResourcesEvent }
  | { readonly event: "bye"; readonly data: LiveSyncByeEvent };

const eventSchemas = {
  hello: liveSyncHelloEventSchema,
  changes: liveSyncChangesEventSchema,
  resources: liveSyncResourcesEventSchema,
  bye: liveSyncByeEventSchema,
} as const;

/** Server side: one SSE frame. Data is single-line JSON. */
export const encodeLiveSyncEvent = (event: LiveSyncEvent): string =>
  `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;

/**
 * Client side: parses one SSE frame (the text between blank lines). Returns
 * undefined for comments, unknown event names and malformed data, which a
 * client ignores.
 */
export const decodeLiveSyncEvent = (
  frame: string,
): LiveSyncEvent | undefined => {
  let name: string | undefined;
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line === "" || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value =
      separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") name = value;
    else if (field === "data") data.push(value);
  }
  if (name === undefined || !(name in eventSchemas) || data.length === 0)
    return undefined;
  let json: unknown;
  try {
    json = JSON.parse(data.join("\n"));
  } catch {
    return undefined;
  }
  const event = name as LiveSyncEventName;
  const parsed = eventSchemas[event].safeParse(json);
  return parsed.success
    ? ({ event, data: parsed.data } as LiveSyncEvent)
    : undefined;
};
