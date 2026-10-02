import type { CoreTaskField } from "@suite/contracts";
import type {
  DayOrderConflictVersions,
  NoteConflictVersions,
  ResolveTaskConflictInput,
  TaskConflictReview,
} from "../local-store.ts";
import { NoteMarkdown } from "./notes/NoteMarkdown.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface SyncConflictReviewProps {
  readonly reviews: readonly TaskConflictReview[];
  readonly busy: boolean;
  readonly onResolve: (input: ResolveTaskConflictInput) => Promise<void>;
}

const valueText = (value: unknown): string => {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    "kind" in value &&
    "value" in value &&
    (value.kind === "date" || value.kind === "instant") &&
    typeof value.value === "string"
  )
    return value.kind === "date"
      ? `Date: ${value.value}`
      : `Date and time: ${value.value}`;
  return JSON.stringify(value);
};

const fieldsFor = (review: TaskConflictReview): readonly CoreTaskField[] =>
  (Object.keys(review.attemptedFields ?? {}) as CoreTaskField[]).length > 0
    ? (Object.keys(review.attemptedFields ?? {}) as CoreTaskField[])
    : (review.conflict.conflictingFields ?? []);

const attemptedValue = (review: TaskConflictReview, field: CoreTaskField) => {
  const fields = review.attemptedFields;
  if (fields === null) return null;
  return (fields as Readonly<Record<CoreTaskField, unknown>>)[field];
};

const entityLabel: Record<string, string> = {
  project: "Project",
  tag: "Tag",
  subtask: "Checklist item",
  day_order: "Day order",
  time_entry: "Time entry",
};

/** ADR 0050: why the server refused a queued time entry write. */
const timeEntryReason: Record<string, string> = {
  revision:
    "The entry changed on another device before your change synced. The current entry is shown in the Worklog.",
  record:
    "The entry no longer exists, or its ID was already used. Nothing was changed.",
  task_unavailable:
    "Time can be recorded only on active tasks; this task was archived or deleted.",
  entry_read_only:
    "Focus time belongs to its session; add a manual correction for the day instead.",
  duration_invalid:
    "The duration must be nonzero and within one day; imported entries stay positive.",
  day_total_negative:
    "The task's time for that day would drop below zero once focus time is counted.",
  day_total_exceeds_day:
    "The task's time for that day would exceed 24 hours once focus time is counted.",
  focus_running:
    "A focus session was running on this task that day; stop it before lowering the day's time.",
};

/**
 * ADR 0050: two devices reordered the same date. The saved order is shown
 * on Today and the Planner; the local order stays in the outbox until the
 * owner keeps the saved one or saves the local one over it.
 */
const DayOrderConflictCard = ({
  review,
  versions,
  busy,
  onResolve,
}: {
  readonly review: TaskConflictReview;
  readonly versions: DayOrderConflictVersions;
  readonly busy: boolean;
  readonly onResolve: SyncConflictReviewProps["onResolve"];
}) => {
  const base = {
    operationId: review.conflict.operationId,
    reviewedTaskRevision:
      versions.canonical?.revision ?? review.conflict.taskRevision,
    reviewedFieldVersions: {},
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Day order conflict</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Alert variant="warning">
          <AlertTitle>Your order for {versions.date} was not saved</AlertTitle>
          <AlertDescription>
            The order of this day changed on another device before your change
            synced. The current order is shown on Today and the Planner. Your
            order is kept until you choose.
          </AlertDescription>
        </Alert>
        {review.retryLocalUnavailableReason === "pending-local-sync" && (
          <p role="status">
            A newer local reorder of this day is still syncing. Wait for it
            before using your order.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void onResolve({ ...base, choice: "keep-current" })}
          >
            Keep current order
          </Button>
          {review.retryLocalSupported && (
            <Button
              type="button"
              disabled={busy}
              onClick={() => void onResolve({ ...base, choice: "retry-local" })}
            >
              Use my order
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

/**
 * ADR 0046: a note conflict shows the server's note and the local attempt
 * side by side. Neither is discarded until the owner chooses.
 */
const NoteConflictCard = ({
  review,
  versions,
  busy,
  onResolve,
}: {
  readonly review: TaskConflictReview;
  readonly versions: NoteConflictVersions;
  readonly busy: boolean;
  readonly onResolve: SyncConflictReviewProps["onResolve"];
}) => {
  const { canonical, local, attempted } = versions;
  const base = {
    operationId: review.conflict.operationId,
    reviewedTaskRevision: canonical?.revision ?? review.conflict.taskRevision,
    reviewedFieldVersions: {},
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Note conflict</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Alert variant="warning">
          <AlertTitle>The local change was not applied</AlertTitle>
          <AlertDescription>
            {canonical === null
              ? "This note no longer exists on the server."
              : "This note changed on another device before your change synced."}{" "}
            Both versions are kept until you choose.
          </AlertDescription>
        </Alert>
        <div className="grid gap-3 md:grid-cols-2">
          <section aria-label="Current note">
            <h3>Current note</h3>
            {canonical === null ? (
              <p>Deleted.</p>
            ) : (
              <>
                <NoteMarkdown content={canonical.content} />
                {canonical.pinnedToToday && <small>Pinned to Today</small>}
              </>
            )}
          </section>
          <section aria-label="Your version">
            <h3>Your version</h3>
            {attempted === "delete" ? (
              <p>You deleted this note.</p>
            ) : local === null ? (
              <p>The local change is no longer available.</p>
            ) : (
              <>
                <NoteMarkdown content={local.content} />
                {local.pinnedToToday && <small>Pinned to Today</small>}
              </>
            )}
          </section>
        </div>
        {review.retryLocalUnavailableReason === "pending-local-sync" && (
          <p role="status">
            A newer local change to this note is still syncing. Wait for it
            before replacing the current note.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void onResolve({ ...base, choice: "keep-current" })}
          >
            {canonical === null ? "Dismiss" : "Keep current note"}
          </Button>
          {versions.keepBothSupported && (
            <Button
              type="button"
              disabled={busy}
              onClick={() => void onResolve({ ...base, choice: "keep-both" })}
            >
              Save mine as a new note
            </Button>
          )}
          {review.retryLocalSupported && (
            <Button
              type="button"
              variant={attempted === "delete" ? "destructive" : "outline"}
              disabled={busy}
              onClick={() => void onResolve({ ...base, choice: "retry-local" })}
            >
              {attempted === "delete"
                ? "Delete the current note"
                : "Replace with mine"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export const SyncConflictReview = ({
  reviews,
  busy,
  onResolve,
}: SyncConflictReviewProps) => {
  if (reviews.length === 0) return null;

  return (
    <section aria-labelledby="sync-conflicts-title">
      <h2 id="sync-conflicts-title">Sync conflicts need review</h2>
      <div className="grid gap-3">
        {reviews.map((review) => {
          const entityKind = review.conflict.entityKind ?? "task";
          if (review.note !== undefined)
            return (
              <NoteConflictCard
                key={review.conflict.operationId}
                review={review}
                versions={review.note}
                busy={busy}
                onResolve={onResolve}
              />
            );
          if (review.dayOrder !== undefined)
            return (
              <DayOrderConflictCard
                key={review.conflict.operationId}
                review={review}
                versions={review.dayOrder}
                busy={busy}
                onResolve={onResolve}
              />
            );
          if (entityKind !== "task")
            // ADR 0033: record conflicts are dismissed once the canonical
            // record has been pulled; nothing is retried locally.
            return (
              <Card key={review.conflict.operationId}>
                <CardHeader>
                  <CardTitle>{entityLabel[entityKind]} conflict</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3">
                  <Alert variant="warning">
                    <AlertTitle>The local change was not applied</AlertTitle>
                    <AlertDescription>
                      {entityKind === "time_entry"
                        ? `${
                            (review.conflict.reasons ?? [])
                              .map((reason) => timeEntryReason[reason])
                              .find((text) => text !== undefined) ??
                            "The server did not accept this time entry change."
                          } Make the change again in the Worklog if it still applies.`
                        : "The record changed elsewhere, was already created, or its name is taken. The current record has been refreshed; make the change again if it still applies."}
                    </AlertDescription>
                  </Alert>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void onResolve({
                          operationId: review.conflict.operationId,
                          choice: "keep-current",
                          reviewedTaskRevision: review.conflict.taskRevision,
                          reviewedFieldVersions: {},
                        })
                      }
                    >
                      Dismiss
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          const fields = fieldsFor(review);
          const canonical = review.canonical;
          const attemptedFields = Object.keys(
            review.attemptedFields ?? {},
          ) as CoreTaskField[];
          const base =
            canonical === null
              ? null
              : {
                  operationId: review.conflict.operationId,
                  reviewedTaskRevision: canonical.task.revision,
                  reviewedFieldVersions: Object.fromEntries(
                    attemptedFields.map((field) => [
                      field,
                      canonical.fieldVersions[field],
                    ]),
                  ),
                };
          return (
            <Card key={review.conflict.operationId}>
              <CardHeader>
                <CardTitle>Task conflict</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3">
                {canonical === null ? (
                  <Alert variant="warning">
                    <AlertTitle>Current task unavailable</AlertTitle>
                    <AlertDescription>
                      Refresh sync data before resolving this conflict.
                    </AlertDescription>
                  </Alert>
                ) : (
                  <>
                    <p>
                      Review changes for <strong>{canonical.task.title}</strong>
                      .
                    </p>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Field</TableHead>
                          <TableHead>Current value</TableHead>
                          <TableHead>Local attempted value</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {fields.map((field) => (
                          <TableRow key={field}>
                            <TableCell>{field}</TableCell>
                            <TableCell>
                              {valueText(canonical.task[field])}
                            </TableCell>
                            <TableCell>
                              {valueText(attemptedValue(review, field))}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </>
                )}
                {base === null || !review.retryLocalSupported ? (
                  <Alert variant="warning">
                    <AlertTitle>
                      {review.retryLocalUnavailableReason ===
                      "pending-local-sync"
                        ? "A newer local change is still syncing"
                        : "Manual review required"}
                    </AlertTitle>
                    <AlertDescription>
                      {review.retryLocalUnavailableReason ===
                      "pending-local-sync"
                        ? "Wait for the newer local task change to finish syncing, then refresh this review before retrying."
                        : "This resource conflict cannot be retried locally. Keep it visible until you have reviewed the current task data."}
                    </AlertDescription>
                  </Alert>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void onResolve({ ...base, choice: "keep-current" })
                      }
                    >
                      Keep current values
                    </Button>
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void onResolve({ ...base, choice: "retry-local" })
                      }
                    >
                      Retry local values
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
};
