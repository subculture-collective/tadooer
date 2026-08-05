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
