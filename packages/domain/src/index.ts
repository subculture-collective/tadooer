export const boundedContexts = [
  "auth",
  "tasks",
  "calendar-projection",
  "active-session",
  "synchronization",
  "automation",
] as const;

export type BoundedContext = (typeof boundedContexts)[number];

export type OwnerId = string & { readonly ownerId: unique symbol };
export type ClientId = string & { readonly clientId: unique symbol };
export type TaskId = string & { readonly taskId: unique symbol };
export type CalendarProviderId = string & {
  readonly calendarProviderId: unique symbol;
};
export type CalendarId = string & { readonly calendarId: unique symbol };
export type EventId = string & { readonly eventId: unique symbol };
export type Revision = number & { readonly revision: unique symbol };

export interface CalendarEventIdentity {
  readonly providerId: CalendarProviderId;
  readonly calendarId: CalendarId;
  readonly eventId: EventId;
}

export interface AuthorizationContext {
  readonly ownerId: OwnerId;
  readonly clientId: ClientId | null;
  readonly actor: "owner-session" | "automation";
}

export * from "./active-session.ts";
export * from "./choice-pool.ts";
export * from "./day-planning.ts";
export * from "./habits.ts";
export * from "./notifications.ts";
export * from "./structured-capture.ts";

export * from "./calendar-freshness.ts";
