import { z } from "zod";
import {
  organizationColorSchema,
  organizationIconSchema,
} from "./organization.ts";

/**
 * Read-only iCal subscriptions (issue #91, ADR 0032). A subscription names a
 * feed address the server fetches on a schedule; events are projected into
 * the planner beside provider calendars. The address may embed a private
 * token, so no response, log or assistant resource ever carries it: only the
 * host is returned. Subscriptions never write upstream.
 */

/** Longest number of subscriptions one owner may keep. */
export const calendarSubscriptionMaxCount = 25;
/** Refresh interval bounds in minutes; the default matches Super Productivity. */
export const calendarSubscriptionRefreshBounds = {
  min: 5,
  max: 24 * 60,
  default: 120,
} as const;
/** Longest event window one events request may read (days). */
export const calendarSubscriptionMaxWindowDays = 31;

export const calendarSubscriptionUrlSchema = z.string().trim().min(1).max(2048);

const filterSchema = z.string().max(256).nullable();

export const calendarSubscriptionSettingsSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    refreshIntervalMinutes: z
      .number()
      .int()
      .min(calendarSubscriptionRefreshBounds.min)
      .max(calendarSubscriptionRefreshBounds.max),
    color: organizationColorSchema.nullable(),
    icon: organizationIconSchema.nullable(),
    /** Case-insensitive title filter; an unusable pattern hides everything. */
    includePattern: filterSchema,
    /** Case-insensitive title filter; an unusable pattern excludes nothing. */
    excludePattern: filterSchema,
    /** Context only: no conversion to tasks and no auto-import. */
    referenceOnly: z.boolean(),
    /** Create tasks for today's events on the server tick. */
    autoImport: z.boolean(),
    /** Paused subscriptions are not fetched and contribute no events. */
    enabled: z.boolean(),
    /** Hidden subscriptions keep their events but leave the planner. */
    hidden: z.boolean(),
  })
  .strict();

export const calendarSubscriptionFetchStateSchema = z.enum([
  "never",
  "fresh",
  "stale",
  "unavailable",
]);

export const calendarSubscriptionFreshnessSchema = z
  .object({
    state: calendarSubscriptionFetchStateSchema,
    message: z.string().trim().min(1).max(240),
  })
  .strict();

/** Bounded classification of the last failed fetch; never a message body. */
export const calendarSubscriptionErrorClassSchema = z
  .string()
  .regex(/^[a-z0-9_]{1,40}$/);

export const calendarSubscriptionSchema = calendarSubscriptionSettingsSchema
  .extend({
    id: z.uuid(),
    ownerId: z.uuid(),
    revision: z.number().int().positive(),
    /** The only address-derived value returned. */
    urlHost: z.string().trim().min(1).max(253),
    freshness: calendarSubscriptionFreshnessSchema,
    lastAttemptAt: z.iso.datetime().nullable(),
    lastSuccessAt: z.iso.datetime().nullable(),
    lastErrorClass: calendarSubscriptionErrorClassSchema.nullable(),
    nextFetchAt: z.iso.datetime(),
    eventCount: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

export const calendarSubscriptionCreateRequestSchema =
  calendarSubscriptionSettingsSchema
    .partial()
    .extend({
      name: calendarSubscriptionSettingsSchema.shape.name,
      url: calendarSubscriptionUrlSchema,
    })
    .strict();

/** Settings patch; a new `url` discards the previous feed's events. */
export const calendarSubscriptionPatchRequestSchema =
  calendarSubscriptionSettingsSchema
    .partial()
    .extend({ url: calendarSubscriptionUrlSchema.optional() })
    .strict();

export const calendarSubscriptionListResponseSchema = z
  .object({ subscriptions: z.array(calendarSubscriptionSchema) })
  .strict();

export const calendarSubscriptionMutationResponseSchema = z
  .object({ subscription: calendarSubscriptionSchema })
  .strict();

export const calendarSubscriptionFetchCountsSchema = z
  .object({
    components: z.number().int().nonnegative(),
    series: z.number().int().nonnegative(),
    unsupportedRecurrence: z.number().int().nonnegative(),
    unknownTimeZones: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    truncated: z.number().int().nonnegative(),
  })
  .strict();

export const calendarSubscriptionFetchResultSchema = z.discriminatedUnion(
  "kind",
  [
    z
      .object({
        kind: z.literal("fetched"),
        events: z.number().int().nonnegative(),
        counts: calendarSubscriptionFetchCountsSchema,
      })
      .strict(),
    z.object({ kind: z.literal("unchanged") }).strict(),
    z
      .object({
        kind: z.literal("failed"),
        errorClass: calendarSubscriptionErrorClassSchema,
      })
      .strict(),
  ],
);

export const calendarSubscriptionRefreshResponseSchema = z
  .object({
    subscription: calendarSubscriptionSchema,
    fetch: calendarSubscriptionFetchResultSchema,
  })
  .strict();

/** One occurrence of a subscribed event with its owner-side state. */
export const calendarSubscriptionEventSchema = z
  .object({
    subscriptionId: z.uuid(),
    subscriptionName: z.string().trim().min(1).max(100),
    referenceOnly: z.boolean(),
    uid: z.string().min(1).max(512),
    /** ISO instant, or a calendar date for all-day events. */
    occurrenceStart: z.string().min(1).max(64),
    summary: z.string().max(1024),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    allDay: z.boolean(),
    recurring: z.boolean(),
    url: z.string().max(1024).nullable(),
    hidden: z.boolean(),
    /** Task created from this occurrence, while it exists. */
    taskId: z.uuid().nullable(),
    /** Converted or dismissed: auto-import never creates it again. */
    tombstoned: z.boolean(),
  })
  .strict();

const windowDays = calendarSubscriptionMaxWindowDays;

export const calendarSubscriptionEventQuerySchema = z
  .object({ from: z.iso.datetime(), to: z.iso.datetime() })
  .strict()
  .refine(
    ({ from, to }) => {
      const span = Date.parse(to) - Date.parse(from);
      return span > 0 && span <= windowDays * 24 * 60 * 60 * 1000;
    },
    {
      message: `Window must be positive and at most ${String(windowDays)} days`,
    },
  );

export const calendarSubscriptionEventListResponseSchema = z
  .object({ events: z.array(calendarSubscriptionEventSchema) })
  .strict();

export const calendarSubscriptionEventKeySchema = z
  .object({
    uid: calendarSubscriptionEventSchema.shape.uid,
    occurrenceStart: calendarSubscriptionEventSchema.shape.occurrenceStart,
  })
  .strict();

export const calendarSubscriptionEventHiddenRequestSchema =
  calendarSubscriptionEventKeySchema.extend({ hidden: z.boolean() }).strict();

export const calendarSubscriptionEventMutationResponseSchema = z
  .object({ event: calendarSubscriptionEventSchema })
  .strict();

// ── Assistant catalog inputs ───────────────────────────────────────────────

/** Subscriptions, plus their events when a window is given. */
export const calendarSubscriptionResourceInputSchema = z
  .object({
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
  })
  .strict()
  .refine(
    ({ from, to }) => {
      if (from === undefined && to === undefined) return true;
      if (from === undefined || to === undefined) return false;
      const span = Date.parse(to) - Date.parse(from);
      return span > 0 && span <= windowDays * 24 * 60 * 60 * 1000;
    },
    {
      message: `Give both from and to, at most ${String(windowDays)} days apart, or neither`,
    },
  );

export const calendarSubscriptionResourceSchema = z
  .object({
    subscriptions: z.array(calendarSubscriptionSchema),
    events: z.array(calendarSubscriptionEventSchema),
  })
  .strict();

export const automationCalendarSubscriptionRefreshInputSchema = z
  .object({
    subscriptionId: z.uuid(),
    expectedRevision: z.number().int().positive(),
  })
  .strict();

export const automationCalendarSubscriptionEventInputSchema = z
  .object({
    subscriptionId: z.uuid(),
    uid: calendarSubscriptionEventSchema.shape.uid,
    occurrenceStart: calendarSubscriptionEventSchema.shape.occurrenceStart,
  })
  .strict();

export const automationCalendarSubscriptionHideInputSchema =
  automationCalendarSubscriptionEventInputSchema
    .extend({ hidden: z.boolean() })
    .strict();

export type CalendarSubscriptionSettings = z.infer<
  typeof calendarSubscriptionSettingsSchema
>;
export type CalendarSubscription = z.infer<typeof calendarSubscriptionSchema>;
export type CalendarSubscriptionCreateRequest = z.infer<
  typeof calendarSubscriptionCreateRequestSchema
>;
export type CalendarSubscriptionPatchRequest = z.infer<
  typeof calendarSubscriptionPatchRequestSchema
>;
export type CalendarSubscriptionListResponse = z.infer<
  typeof calendarSubscriptionListResponseSchema
>;
export type CalendarSubscriptionMutationResponse = z.infer<
  typeof calendarSubscriptionMutationResponseSchema
>;
export type CalendarSubscriptionFetchResult = z.infer<
  typeof calendarSubscriptionFetchResultSchema
>;
export type CalendarSubscriptionRefreshResponse = z.infer<
  typeof calendarSubscriptionRefreshResponseSchema
>;
export type CalendarSubscriptionEvent = z.infer<
  typeof calendarSubscriptionEventSchema
>;
export type CalendarSubscriptionEventListResponse = z.infer<
  typeof calendarSubscriptionEventListResponseSchema
>;
export type CalendarSubscriptionEventMutationResponse = z.infer<
  typeof calendarSubscriptionEventMutationResponseSchema
>;
export type CalendarSubscriptionResource = z.infer<
  typeof calendarSubscriptionResourceSchema
>;
