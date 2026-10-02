import { useEffect, useRef, useState } from "react";
import type {
  CalendarBridgeDirection,
  CalendarBridgeInitialSyncChoice,
  CalendarBridgeMappingCreateRequest,
  CalendarBridgeMappingPreviewResponse,
  CalendarBridgeMappingSummary,
  CalendarBridgeReviewResponse,
  CalendarCollection,
  GoogleConnectorStatusResponse,
} from "@suite/contracts";
import {
  createCalendarBridgeMapping,
  decideCalendarBridgeDeletion,
  getCalendarBridgeOverview,
  getCalendarBridgeReview,
  previewCalendarBridgeMapping,
  removeCalendarBridgeMapping,
  resolveCalendarBridgeConflict,
  runCalendarBridgeMapping,
  setCalendarBridgeMappingEnabled,
} from "../api.ts";
import {
  allowedDirections,
  attentionText,
  baikalCalendarChoices,
  blockedReasonText,
  copySummary,
  directionLabel,
  emptyMappingForm,
  formatInstant,
  formatWhen,
  googleCalendarChoices,
  initialSyncLabel,
  lastErrorText,
  mappingInputFromForm,
  previewMatches,
  refusalText,
  removalPlan,
  reviewActionText,
  runOutcomeText,
  sideName,
  stateLabel,
  stateVariant,
  versionLines,
  type CalendarBridgeApi,
  type GoogleCalendarChoice,
  type MappingFormValues,
  type PendingReviewAction,
} from "./calendar-bridge-controller.ts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { SectionHeading } from "@/components/ui/section-heading";
import { useLiveRefetch } from "../live-sync/views.ts";

const defaultApi: CalendarBridgeApi = {
  overview: getCalendarBridgeOverview,
  preview: previewCalendarBridgeMapping,
  create: createCalendarBridgeMapping,
  setEnabled: setCalendarBridgeMappingEnabled,
  remove: removeCalendarBridgeMapping,
  run: runCalendarBridgeMapping,
  review: getCalendarBridgeReview,
  decideDeletion: decideCalendarBridgeDeletion,
  resolveConflict: resolveCalendarBridgeConflict,
};

const directions: readonly CalendarBridgeDirection[] = [
  "two_way",
  "google_to_baikal",
  "baikal_to_google",
];
const initialSyncs: readonly CalendarBridgeInitialSyncChoice[] = [
  "copy_existing",
  "new_only",
];

const refusalLabel: Readonly<Record<string, string>> = {
  "not-connected": "Google not connected",
  "reconnect-required": "reconnect Google",
  "consent-required": "event changes not allowed",
  "scope-missing": "event changes not granted",
  "role-unknown": "access not known yet",
  "read-only-calendar": "read-only for you",
};

export interface CalendarBridgeViewProps {
  readonly googleChoices: readonly GoogleCalendarChoice[];
  readonly baikalChoices: readonly CalendarCollection[];
  readonly writeConsent: boolean;
  readonly form: MappingFormValues;
  readonly preview: CalendarBridgeMappingPreviewResponse | null;
  readonly previewCurrent: boolean;
  readonly mappings: readonly CalendarBridgeMappingSummary[] | null;
  readonly reviews: Readonly<Record<string, CalendarBridgeReviewResponse>>;
  readonly pendingRemoval: {
    readonly mapping: CalendarBridgeMappingSummary;
    readonly discardPending: boolean;
  } | null;
  readonly pendingAction: PendingReviewAction | null;
  readonly busy: boolean;
  readonly message: string | null;
  readonly error: string | null;
  readonly onFormChange: (values: MappingFormValues) => void;
  readonly onPreview: () => void;
  readonly onCreate: () => void;
  readonly onRun: (mapping: CalendarBridgeMappingSummary) => void;
  readonly onToggleEnabled: (mapping: CalendarBridgeMappingSummary) => void;
  readonly onToggleReview: (mapping: CalendarBridgeMappingSummary) => void;
  readonly onRequestRemove: (mapping: CalendarBridgeMappingSummary) => void;
  readonly onDiscardPendingChange: (discard: boolean) => void;
  readonly onConfirmRemove: () => void;
  readonly onCancelRemove: () => void;
  readonly onRequestAction: (action: PendingReviewAction) => void;
  readonly onConfirmAction: () => void;
  readonly onCancelAction: () => void;
}

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

const ReviewPanel = ({
  review,
  busy,
  onRequestAction,
}: {
  readonly review: CalendarBridgeReviewResponse;
  readonly busy: boolean;
  readonly onRequestAction: (action: PendingReviewAction) => void;
}) => {
  const mappingId = review.mapping.id;
  const deletions = review.blocked.filter(
    ({ reason }) => reason === "deletion-approval",
  );
  const blocked = review.blocked.filter(
    ({ reason }) => reason !== "deletion-approval",
  );
  return (
    <div className="grid gap-3" aria-label="Mapping review">
      <section
        className="grid gap-2"
        aria-labelledby={`conflicts-${mappingId}`}
      >
        <h4 id={`conflicts-${mappingId}`} className="font-medium">
          Conflicts
        </h4>
        {review.conflicts.length === 0 ? (
          <p className="text-sm">No conflicts.</p>
        ) : (
          <ul className="grid gap-3">
            {review.conflicts.map((conflict) => (
              <li key={conflict.id} className="grid gap-2">
                <strong>{conflict.title ?? "(untitled)"}</strong>
                <span className="text-sm">
                  {conflict.reason === "resurrection"
                    ? "This event came back after its deletion was accepted."
                    : "Both calendars changed this event since the last sync."}
                </span>
                <div className="grid gap-2 md:grid-cols-2">
                  {(["google", "baikal"] as const).map((side) => (
                    <div
                      key={side}
                      className="grid gap-1 rounded-sm border p-2"
                      aria-label={`${sideName(side)} version`}
                    >
                      <strong className="text-sm">
                        {sideName(side)} version
                      </strong>
                      {versionLines(conflict[side]).map((line) => (
                        <span key={line} className="text-sm">
                          {line}
                        </span>
                      ))}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          onRequestAction({
                            kind: "resolve",
                            mappingId,
                            conflictId: conflict.id,
                            linkRevision: conflict.linkRevision,
                            title: conflict.title,
                            keep: side,
                            keptDeleted: conflict[side].kind === "deleted",
                          })
                        }
                      >
                        Keep {sideName(side)} version
                      </Button>
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section
        className="grid gap-2"
        aria-labelledby={`deletions-${mappingId}`}
      >
        <h4 id={`deletions-${mappingId}`} className="font-medium">
          Deletions awaiting approval
        </h4>
        {deletions.length === 0 ? (
          <p className="text-sm">No deletions are waiting.</p>
        ) : (
          <ul className="grid gap-2">
            {deletions.map((event) => (
              <li key={event.linkId} className="grid gap-1">
                <strong>{event.title ?? "(untitled)"}</strong>
                <span className="text-sm">
                  {[
                    formatWhen(event.start, event.allDay),
                    blockedReasonText(event),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {!event.approved && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        onRequestAction({
                          kind: "deletion",
                          mappingId,
                          event,
                          decision: "approve",
                        })
                      }
                    >
                      Approve deletion
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        onRequestAction({
                          kind: "deletion",
                          mappingId,
                          event,
                          decision: "decline",
                        })
                      }
                    >
                      Keep the other copy
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="grid gap-2" aria-labelledby={`blocked-${mappingId}`}>
        <h4 id={`blocked-${mappingId}`} className="font-medium">
          Blocked events
        </h4>
        {blocked.length === 0 ? (
          <p className="text-sm">No blocked events.</p>
        ) : (
          <ul className="grid gap-1">
            {blocked.map((event) => (
              <li key={event.linkId} className="text-sm">
                <strong>{event.title ?? "(untitled)"}</strong>
                {" · "}
                {[
                  formatWhen(event.start, event.allDay),
                  blockedReasonText(event),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="grid gap-2" aria-labelledby={`writes-${mappingId}`}>
        <h4 id={`writes-${mappingId}`} className="font-medium">
          Pending writes
        </h4>
        {review.operations.length === 0 ? (
          <p className="text-sm">No pending writes.</p>
        ) : (
          <ul className="grid gap-1">
            {review.operations.map((operation) => (
              <li key={operation.id} className="text-sm">
                {operation.action === "create"
                  ? "Copy"
                  : operation.action === "update"
                    ? "Update"
                    : "Delete"}{" "}
                {operation.title === null ? "an event" : `"${operation.title}"`}{" "}
                in {sideName(operation.target)} ·{" "}
                {operation.state === "pending"
                  ? "waiting for the next pass"
                  : "outcome being confirmed"}
                {operation.lastError === null
                  ? ""
                  : ` · last attempt failed (${operation.lastError})`}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};

/**
 * Google-Baikal calendar bridge (ADR 0041, ADR 0044): explicit per-calendar
 * mappings with a preview before creation, status and recovery controls,
 * and review of deletions and conflicts with both versions shown.
 */
export const CalendarBridgeView = ({
  googleChoices,
  baikalChoices,
  writeConsent,
  form,
  preview,
  previewCurrent,
  mappings,
  reviews,
  pendingRemoval,
  pendingAction,
  busy,
  message,
  error,
  onFormChange,
  onPreview,
  onCreate,
  onRun,
  onToggleEnabled,
  onToggleReview,
  onRequestRemove,
  onDiscardPendingChange,
  onConfirmRemove,
  onCancelRemove,
  onRequestAction,
  onConfirmAction,
  onCancelAction,
}: CalendarBridgeViewProps) => {
  const selectedGoogle = googleChoices.find(
    ({ id }) => id === form.googleCalendarId,
  );
  const permitted = allowedDirections(selectedGoogle);
  const plan =
    pendingRemoval === null ? null : removalPlan(pendingRemoval.mapping);
  return (
    <Card aria-labelledby="calendar-bridge-title">
      <CardHeader>
        <SectionHeading
          as="h3"
          id="calendar-bridge-title"
          eyebrow="Google and Baikal"
          title="Calendar bridge"
        />
      </CardHeader>
      <CardContent className="grid gap-4">
        <p>
          Pair one Google calendar with one Baikal calendar. Only the paired
          calendars exchange events. Conflicting edits keep both versions until
          you choose one, and a deletion on one side waits for your approval.
        </p>
        <p className="hint">
          Online only. Passes run when you choose Run pass now.
        </p>
        {!writeConsent && (
          <Alert variant="warning">
            <AlertDescription>
              Allow Google event changes above before creating a mapping.
            </AlertDescription>
          </Alert>
        )}
        {message !== null && (
          <p role="status" aria-live="polite">
            {message}
          </p>
        )}
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <form
          className="grid gap-3"
          aria-label="Create a calendar mapping"
          onSubmit={(event) => {
            event.preventDefault();
            onPreview();
          }}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="bridge-google">Google calendar</FieldLabel>
              <NativeSelect
                id="bridge-google"
                value={form.googleCalendarId}
                onChange={(event) => {
                  const choice = googleChoices.find(
                    ({ id }) => id === event.target.value,
                  );
                  onFormChange({
                    ...form,
                    googleCalendarId: event.target.value,
                    direction:
                      form.direction !== "" &&
                      !allowedDirections(choice).includes(form.direction)
                        ? ""
                        : form.direction,
                  });
                }}
              >
                <NativeSelectOption value="">Choose…</NativeSelectOption>
                {googleChoices.map((choice) => (
                  <NativeSelectOption key={choice.id} value={choice.id}>
                    {choice.name} (
                    {choice.writable
                      ? "writable"
                      : `read only: ${refusalLabel[choice.reason ?? ""] ?? choice.reason ?? "unknown"}`}
                    )
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="bridge-baikal">Baikal calendar</FieldLabel>
              <NativeSelect
                id="bridge-baikal"
                value={form.baikalCalendarId}
                onChange={(event) =>
                  onFormChange({
                    ...form,
                    baikalCalendarId: event.target.value,
                  })
                }
              >
                <NativeSelectOption value="">Choose…</NativeSelectOption>
                {baikalChoices.map((calendar) => (
                  <NativeSelectOption key={calendar.id} value={calendar.id}>
                    {calendar.displayName}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <fieldset className="grid gap-1">
            <legend className="text-sm font-medium">Direction</legend>
            {directions.map((direction) => (
              <label
                key={direction}
                className="flex items-center gap-2 text-sm"
              >
                <input
                  type="radio"
                  name="bridge-direction"
                  value={direction}
                  checked={form.direction === direction}
                  disabled={!permitted.includes(direction)}
                  onChange={() => onFormChange({ ...form, direction })}
                />
                {directionLabel(direction)}
              </label>
            ))}
          </fieldset>
          <fieldset className="grid gap-1">
            <legend className="text-sm font-medium">Existing events</legend>
            {initialSyncs.map((initialSync) => (
              <label
                key={initialSync}
                className="flex items-center gap-2 text-sm"
              >
                <input
                  type="radio"
                  name="bridge-initial-sync"
                  value={initialSync}
                  checked={form.initialSync === initialSync}
                  onChange={() => onFormChange({ ...form, initialSync })}
                />
                {initialSyncLabel(initialSync)}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="outline" disabled={busy}>
              Preview
            </Button>
            <Button
              type="button"
              disabled={
                busy ||
                !previewCurrent ||
                preview === null ||
                preview.refusals.length > 0
              }
              onClick={onCreate}
            >
              Create mapping
            </Button>
          </div>
        </form>
        {preview !== null && previewCurrent && (
          <section
            className="grid gap-2"
            aria-labelledby="bridge-preview-title"
          >
            <h4 id="bridge-preview-title" className="font-medium">
              What this mapping would do
            </h4>
            {preview.refusals.length > 0 ? (
              <ul className="grid gap-1">
                {preview.refusals.map((refusal) => (
                  <li key={refusal} className="text-sm">
                    {refusalText(refusal)}
                  </li>
                ))}
              </ul>
            ) : null}
            <ul className="grid gap-2">
              {preview.copies.map((copy, index) => (
                <li key={copy.from} className="grid gap-1 text-sm">
                  <span>{copySummary(preview)[index]}</span>
                  {preview.initialSync === "copy_existing" &&
                    copy.sample.length > 0 && (
                      <ul className="grid gap-0.5 pl-4">
                        {copy.sample.map((event) => (
                          <li key={`${event.startsAt}:${event.summary}`}>
                            {formatWhen(event.startsAt, event.allDay)} ·{" "}
                            {event.summary === ""
                              ? "(untitled)"
                              : event.summary}
                          </li>
                        ))}
                        {copy.copied > copy.sample.length && (
                          <li>
                            and{" "}
                            {plural(
                              copy.copied - copy.sample.length,
                              "more event",
                            )}
                          </li>
                        )}
                      </ul>
                    )}
                </li>
              ))}
            </ul>
            <p className="hint">
              Counts come from the events Tadooer last read, not every event the
              first pass will see. Events with guests, repeats or other content
              the bridge does not copy are held for review.
            </p>
          </section>
        )}
        {pendingRemoval !== null && plan !== null && (
          <div role="alertdialog" aria-labelledby="bridge-remove-confirm">
            <p id="bridge-remove-confirm">
              Remove the mapping between{" "}
              {pendingRemoval.mapping.googleCalendarName ?? "Google"} and{" "}
              {pendingRemoval.mapping.baikalCalendarName ?? "Baikal"}? No events
              are deleted from either calendar.
            </p>
            {plan.kind === "in-flight" && (
              <p>
                {plural(plan.count, "write")} has an unconfirmed outcome. Run a
                pass first so it can be checked; the mapping cannot be removed
                until then.
              </p>
            )}
            {plan.kind === "pending" && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={pendingRemoval.discardPending}
                  onCheckedChange={(checked) =>
                    onDiscardPendingChange(checked === true)
                  }
                />
                Discard {plural(plan.count, "pending write")}; they will not be
                sent
              </label>
            )}
            <Button
              type="button"
              variant="destructive"
              disabled={
                busy ||
                plan.kind === "in-flight" ||
                (plan.kind === "pending" && !pendingRemoval.discardPending)
              }
              onClick={onConfirmRemove}
            >
              Remove mapping
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onCancelRemove}
            >
              Cancel
            </Button>
          </div>
        )}
        {pendingAction !== null && (
          <div role="alertdialog" aria-labelledby="bridge-action-confirm">
            <p id="bridge-action-confirm">{reviewActionText(pendingAction)}</p>
            <Button
              type="button"
              variant={
                pendingAction.kind === "deletion" &&
                pendingAction.decision === "decline"
                  ? "default"
                  : "destructive"
              }
              disabled={busy}
              onClick={onConfirmAction}
            >
              Confirm
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onCancelAction}
            >
              Cancel
            </Button>
          </div>
        )}
        {mappings === null ? (
          error === null && <p>Loading calendar mappings…</p>
        ) : mappings.length === 0 ? (
          <p>No calendar mappings yet.</p>
        ) : (
          <ul className="grid gap-4">
            {mappings.map((mapping) => {
              const review = reviews[mapping.id];
              return (
                <li key={mapping.id} className="grid gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>
                      {mapping.googleCalendarName ??
                        "Unavailable Google calendar"}{" "}
                      ↔{" "}
                      {mapping.baikalCalendarName ??
                        "Unavailable Baikal calendar"}
                    </strong>
                    <Badge variant={stateVariant(mapping.state)}>
                      {stateLabel[mapping.state]}
                    </Badge>
                    {mapping.stale && mapping.state !== "paused" && (
                      <Badge variant="warning">Stale</Badge>
                    )}
                  </div>
                  <span className="text-sm">
                    {directionLabel(mapping.direction)} ·{" "}
                    {initialSyncLabel(mapping.initialSync)} · last pass{" "}
                    {formatInstant(mapping.lastRunAt)} · last success{" "}
                    {formatInstant(mapping.lastSuccessAt)}
                    {mapping.lastErrorCode === null
                      ? ""
                      : ` · failed: ${lastErrorText(mapping.lastErrorCode)}`}
                  </span>
                  <span className="text-sm">
                    {plural(mapping.counts.active, "synced event")} ·{" "}
                    {plural(
                      mapping.counts.pendingWrites +
                        mapping.counts.inFlightWrites,
                      "pending write",
                    )}{" "}
                    · {plural(mapping.counts.conflicts, "conflict")} ·{" "}
                    {plural(mapping.counts.pendingDeletions, "deletion")}{" "}
                    awaiting approval ·{" "}
                    {plural(
                      mapping.counts.blocked - mapping.counts.pendingDeletions,
                      "blocked event",
                    )}
                  </span>
                  {mapping.attention.filter((code) => code !== "not-run")
                    .length > 0 && (
                    <ul className="grid gap-0.5 text-sm">
                      {mapping.attention
                        .filter((code) => code !== "not-run")
                        .map((code) => (
                          <li key={code}>{attentionText(code)}</li>
                        ))}
                    </ul>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy || !mapping.enabled}
                      onClick={() => onRun(mapping)}
                    >
                      Run pass now
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => onToggleEnabled(mapping)}
                    >
                      {mapping.enabled ? "Pause" : "Resume"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-expanded={review !== undefined}
                      onClick={() => onToggleReview(mapping)}
                    >
                      {review === undefined ? "Review" : "Hide review"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label={`Remove mapping ${mapping.googleCalendarName ?? ""} and ${mapping.baikalCalendarName ?? ""}`}
                      onClick={() => onRequestRemove(mapping)}
                    >
                      Remove
                    </Button>
                  </div>
                  {review !== undefined && (
                    <ReviewPanel
                      review={review}
                      busy={busy}
                      onRequestAction={onRequestAction}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
};

export const CalendarBridge = ({
  csrfToken,
  google,
  baikalCalendars,
  api = defaultApi,
}: {
  readonly csrfToken: string;
  readonly google: GoogleConnectorStatusResponse | undefined;
  readonly baikalCalendars: readonly CalendarCollection[];
  readonly api?: CalendarBridgeApi;
}) => {
  const [mappings, setMappings] = useState<
    readonly CalendarBridgeMappingSummary[] | null
  >(null);
  const [reviews, setReviews] = useState<
    Readonly<Record<string, CalendarBridgeReviewResponse>>
  >({});
  const [form, setForm] = useState<MappingFormValues>(emptyMappingForm);
  const [preview, setPreview] =
    useState<CalendarBridgeMappingPreviewResponse | null>(null);
  const [previewed, setPreviewed] =
    useState<CalendarBridgeMappingCreateRequest | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<{
    readonly mapping: CalendarBridgeMappingSummary;
    readonly discardPending: boolean;
  } | null>(null);
  const [pendingAction, setPendingAction] =
    useState<PendingReviewAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  // Mappings whose review is open; each reload refreshes them.
  const openReviews = useRef(new Set<string>());
  useEffect(() => {
    let current = true;
    const stillCurrent = () => current;
    api
      .overview()
      .then(async (overview) => {
        if (!current) return;
        setMappings(overview.mappings);
        // Refresh open reviews after every change.
        const open = [...openReviews.current].filter((id) =>
          overview.mappings.some((mapping) => mapping.id === id),
        );
        const loaded = await Promise.all(open.map((id) => api.review(id)));
        // The effect may have been cleaned up while the reviews loaded.
        if (stillCurrent())
          setReviews(
            Object.fromEntries(
              loaded.map((review) => [review.mapping.id, review]),
            ),
          );
      })
      .catch(() => {
        if (current) setError("Could not load calendar mappings.");
      });
    return () => {
      current = false;
    };
  }, [api, reloads]);
  const reload = () => setReloads((count) => count + 1);
  useLiveRefetch("calendarBridge", reload);
  const run = async (work: () => Promise<string | null>, failure: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setMessage(await work());
      reload();
    } catch (caught: unknown) {
      const detail =
        caught instanceof Error && caught.message !== ""
          ? ` ${caught.message}`
          : "";
      setError(`${failure}${detail}`);
    } finally {
      setBusy(false);
    }
  };
  const input = mappingInputFromForm(form);
  return (
    <CalendarBridgeView
      googleChoices={googleCalendarChoices(google)}
      baikalChoices={baikalCalendarChoices(baikalCalendars)}
      writeConsent={google?.write.consent === "granted"}
      form={form}
      preview={preview}
      previewCurrent={previewMatches(preview, input, previewed)}
      mappings={mappings}
      reviews={reviews}
      pendingRemoval={pendingRemoval}
      pendingAction={pendingAction}
      busy={busy}
      message={message}
      error={error}
      onFormChange={(values) => {
        setForm(values);
        setPreview(null);
        setPreviewed(null);
      }}
      onPreview={() => {
        if ("error" in input) {
          setError(input.error);
          return;
        }
        void run(async () => {
          setPreview(await api.preview(input, csrfToken));
          setPreviewed(input);
          return null;
        }, "Could not preview that mapping.");
      }}
      onCreate={() => {
        if ("error" in input) return;
        void run(async () => {
          await api.create(input, csrfToken);
          setForm(emptyMappingForm);
          setPreview(null);
          setPreviewed(null);
          return "Mapping created. Run a pass to start syncing.";
        }, "Could not create that mapping.");
      }}
      onRun={(mapping) =>
        void run(
          async () => runOutcomeText(await api.run(mapping.id, csrfToken)),
          "Could not run a pass.",
        )
      }
      onToggleEnabled={(mapping) =>
        void run(async () => {
          await api.setEnabled(
            mapping.id,
            mapping.revision,
            !mapping.enabled,
            csrfToken,
          );
          return mapping.enabled
            ? "Mapping paused. Pending writes are kept."
            : "Mapping resumed.";
        }, "Could not change that mapping. It may have changed; reload and try again.")
      }
      onToggleReview={(mapping) => {
        if (reviews[mapping.id] !== undefined) {
          openReviews.current.delete(mapping.id);
          const { [mapping.id]: _closed, ...rest } = reviews;
          void _closed;
          setReviews(rest);
          return;
        }
        openReviews.current.add(mapping.id);
        void api
          .review(mapping.id)
          .then((review) =>
            setReviews((open) => ({ ...open, [mapping.id]: review })),
          )
          .catch(() => setError("Could not load that review."));
      }}
      onRequestRemove={(mapping) =>
        setPendingRemoval({ mapping, discardPending: false })
      }
      onDiscardPendingChange={(discardPending) =>
        setPendingRemoval((current) =>
          current === null ? null : { ...current, discardPending },
        )
      }
      onCancelRemove={() => setPendingRemoval(null)}
      onConfirmRemove={() => {
        if (pendingRemoval === null) return;
        const { mapping, discardPending } = pendingRemoval;
        void run(async () => {
          await api.remove(
            mapping.id,
            mapping.revision,
            discardPending,
            csrfToken,
          );
          setPendingRemoval(null);
          return "Mapping removed. No events were deleted.";
        }, "Could not remove that mapping.");
      }}
      onRequestAction={setPendingAction}
      onCancelAction={() => setPendingAction(null)}
      onConfirmAction={() => {
        const action = pendingAction;
        if (action === null) return;
        void run(async () => {
          if (action.kind === "deletion") {
            await api.decideDeletion(
              action.mappingId,
              action.event.linkId,
              action.event.linkRevision,
              action.decision,
              csrfToken,
            );
            setPendingAction(null);
            return action.decision === "approve"
              ? "Deletion approved. The next pass deletes the other copy."
              : "Kept the other copy. This event is no longer synced.";
          }
          await api.resolveConflict(
            action.mappingId,
            action.conflictId,
            action.linkRevision,
            action.keep,
            csrfToken,
          );
          setPendingAction(null);
          return `Keeping the ${sideName(action.keep)} version. The next pass writes it.`;
        }, "Could not apply that decision. The event may have changed; review it again.");
      }}
    />
  );
};
