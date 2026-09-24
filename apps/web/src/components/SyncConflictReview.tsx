import type { CoreTaskField } from "@suite/contracts";
import type {
  ResolveTaskConflictInput,
  TaskConflictReview,
} from "../local-store.ts";
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
