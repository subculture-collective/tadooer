import type { SavedDayOrder, SyncOperation } from "@suite/contracts";

/**
 * Saved day orders in the offline cache (ADR 0050). One pure function says
 * what a queued reorder does to the cached order of its date. The local
 * store uses it for the optimistic write, for the replay of the outbox over
 * a fresh snapshot, and for the rebase of still-pending reorders after a
 * sync round delivered the canonical order.
 */
export type DayOrderOperation = Extract<
  SyncOperation,
  { readonly kind: "day_order.reorder" }
>;

export const isDayOrderOperation = (
  operation: SyncOperation,
): operation is DayOrderOperation => operation.kind === "day_order.reorder";

/**
 * The cached order after one queued reorder. It takes the revision the
 * server will give it (`baseRevision` plus one), so a second offline reorder
 * of the same date is queued against the revision the first one produces.
 * The server may still drop a named task that left the day or append a
 * member this client did not name; its canonical order then replaces this
 * one in the round that applies the reorder.
 */
export const applyDayOrderOperation = (
  operation: DayOrderOperation,
): SavedDayOrder => ({
  date: operation.date,
  revision: operation.baseRevision + 1,
  taskIds: [...operation.taskIds],
  updatedAt: operation.createdAt,
});
