import type {
  AutomationConfirmationResponse,
  AutomationPreviewCommand,
} from "@suite/contracts";
import type { SuiteDatabase } from "@suite/persistence";
import type { CalendarSubscriptionService } from "../calendar-subscriptions.ts";

// Assistant access to iCal subscriptions (issue #91, ADR 0032). automation.ts
// keeps the shared preview/confirm protocol. Adding or removing a
// subscription stays owner-only because the address may embed a token; the
// assistant refreshes a feed, converts an event to a task, or hides an event.
// Previews name the subscription and its host, never the address. A
// subscription is not one of the revisioned entities the generic stale check
// knows, so refresh repeats its revision check at confirmation.

export type CalendarSubscriptionCommand = Extract<
  AutomationPreviewCommand,
  {
    operation:
      | "calendar_subscriptions.refresh"
      | "calendar_subscriptions.convert_event"
      | "calendar_subscriptions.hide_event";
  }
>;

type Result = AutomationConfirmationResponse["result"];

export const isCalendarSubscriptionCommand = (
  command: AutomationPreviewCommand,
): command is CalendarSubscriptionCommand =>
  command.operation === "calendar_subscriptions.refresh" ||
  command.operation === "calendar_subscriptions.convert_event" ||
  command.operation === "calendar_subscriptions.hide_event";

const quoted = (value: string): string =>
  `"${value.length > 60 ? `${value.slice(0, 57)}...` : value}"`;

export type CalendarSubscriptionPreview =
  | {
      readonly ok: true;
      readonly summary: string;
      readonly affected: readonly {
        readonly entityKind: "calendar" | "task";
        readonly entityId: string;
      }[];
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };

const notFound = (what: string): CalendarSubscriptionPreview => ({
  ok: false,
  status: 404,
  code:
    what === "subscription"
      ? "SUBSCRIPTION_NOT_FOUND"
      : "SUBSCRIPTION_EVENT_NOT_FOUND",
  message:
    what === "subscription"
      ? "Calendar subscription not found"
      : "Calendar event not found in the saved feed",
});

export const previewCalendarSubscription = (
  database: SuiteDatabase,
  ownerId: string,
  command: CalendarSubscriptionCommand,
): CalendarSubscriptionPreview => {
  const store = database.calendarSubscriptions;
  const subscription = store.get(ownerId, command.input.subscriptionId);
  if (subscription === undefined) return notFound("subscription");
  if (command.operation === "calendar_subscriptions.refresh") {
    if (subscription.revision !== command.input.expectedRevision)
      return {
        ok: false,
        status: 412,
        code: "SUBSCRIPTION_REVISION_CONFLICT",
        message: "The subscription changed; read it again before refreshing",
      };
    return {
      ok: true,
      summary: `Fetch the ${quoted(subscription.name)} calendar from ${subscription.urlHost} now and replace its saved events. Nothing is written to the calendar.`,
      affected: [{ entityKind: "calendar", entityId: subscription.id }],
    };
  }
  const input = command.input;
  const event = store.getEvent(
    ownerId,
    input.subscriptionId,
    input.uid,
    input.occurrenceStart,
  );
  if (event === undefined) return notFound("event");
  const when = event.allDay
    ? `all day on ${event.occurrenceStart.slice(0, 10)}`
    : `at ${event.startsAt}`;
  if (command.operation === "calendar_subscriptions.hide_event")
    return {
      ok: true,
      summary: `${command.input.hidden ? "Hide" : "Show"} the event ${quoted(event.summary)} (${when}) from ${quoted(subscription.name)}. The calendar itself is not changed.`,
      affected: [{ entityKind: "calendar", entityId: subscription.id }],
    };
  if (subscription.referenceOnly)
    return {
      ok: false,
      status: 409,
      code: "SUBSCRIPTION_REFERENCE_ONLY",
      message: "Events of a reference calendar are context only",
    };
  const existing = store.getConversion(
    ownerId,
    input.subscriptionId,
    input.uid,
    input.occurrenceStart,
  );
  const existingTask =
    existing?.taskId == null
      ? undefined
      : database.getTask(ownerId, existing.taskId, true);
  return {
    ok: true,
    summary:
      existingTask === undefined
        ? `Create a task ${quoted(event.summary)} planned ${when} from the ${quoted(subscription.name)} calendar.`
        : `The event ${quoted(event.summary)} (${when}) already has the task ${quoted(existingTask.title)}; confirmation returns it without creating another.`,
    affected: [
      { entityKind: "calendar", entityId: subscription.id },
      ...(existingTask === undefined
        ? []
        : [{ entityKind: "task" as const, entityId: existingTask.id }]),
    ],
  };
};

/**
 * Confirmation. A refresh fetches over the network, so it runs before the
 * receipt is committed and returns its result directly; the other two apply
 * inside the confirmation transaction.
 */
export const confirmCalendarSubscription = async (
  database: SuiteDatabase,
  service: CalendarSubscriptionService,
  ownerId: string,
  command: CalendarSubscriptionCommand,
  now: () => string,
): Promise<
  | { readonly ok: true; readonly result: Result }
  | { readonly ok: true; readonly apply: () => Result }
  | {
      readonly ok: false;
      readonly status: number;
      readonly message: string;
    }
> => {
  const current = previewCalendarSubscription(database, ownerId, command);
  if (!current.ok)
    return { ok: false, status: current.status, message: current.message };
  if (command.operation === "calendar_subscriptions.refresh") {
    const result = await service.refresh(
      ownerId,
      command.input.subscriptionId,
      now(),
    );
    if (result === undefined)
      return {
        ok: false,
        status: 404,
        message: "Calendar subscription not found",
      };
    return { ok: true, result };
  }
  if (command.operation === "calendar_subscriptions.hide_event") {
    const input = command.input;
    return {
      ok: true,
      apply: () => {
        const result = service.setEventHidden({
          ownerId,
          ...input,
          now: now(),
        });
        if (result.kind !== "ok")
          throw new Error("Calendar event disappeared during confirmation");
        return { event: result.event };
      },
    };
  }
  const input = command.input;
  return {
    ok: true,
    apply: () => {
      const result = service.convertEvent({
        ownerId,
        ...input,
        kind: "manual",
        now: now(),
      });
      if (result.kind !== "ok")
        throw new Error("Calendar event disappeared during confirmation");
      return {
        task: result.task,
        event: result.event,
        replayed: result.replayed,
      };
    },
  };
};
