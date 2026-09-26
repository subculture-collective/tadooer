import { useEffect, useState, type SyntheticEvent } from "react";
import type {
  CalendarSubscription,
  CalendarSubscriptionEvent,
} from "@suite/contracts";
import {
  convertCalendarSubscriptionEvent,
  createCalendarSubscription,
  deleteCalendarSubscription,
  listCalendarSubscriptionEvents,
  listCalendarSubscriptions,
  refreshCalendarSubscription,
  setCalendarSubscriptionEventHidden,
  updateCalendarSubscription,
} from "../api.ts";
import {
  createInputFromForm,
  describeEventTime,
  describeFetch,
  freshnessVariant,
  upcomingWindow,
  type CalendarSubscriptionApi,
} from "./calendar-subscription-controller.ts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SectionHeading } from "@/components/ui/section-heading";

// Stable defaults: both are effect dependencies in the container.
const defaultNow = (): Date => new Date();

const defaultApi: CalendarSubscriptionApi = {
  list: listCalendarSubscriptions,
  create: createCalendarSubscription,
  update: updateCalendarSubscription,
  remove: deleteCalendarSubscription,
  refresh: refreshCalendarSubscription,
  events: listCalendarSubscriptionEvents,
  setHidden: setCalendarSubscriptionEventHidden,
  convert: convertCalendarSubscriptionEvent,
};

export interface CalendarSubscriptionsViewProps {
  readonly subscriptions: readonly CalendarSubscription[] | null;
  readonly events: readonly CalendarSubscriptionEvent[];
  readonly pendingDelete: CalendarSubscription | null;
  readonly busy: boolean;
  readonly message: string | null;
  readonly error: string | null;
  readonly onCreate: (values: {
    readonly name: string;
    readonly url: string;
    readonly refreshIntervalMinutes: string;
    readonly includePattern: string;
    readonly excludePattern: string;
    readonly referenceOnly: boolean;
    readonly autoImport: boolean;
  }) => void;
  readonly onRefresh: (subscription: CalendarSubscription) => void;
  readonly onToggle: (
    subscription: CalendarSubscription,
    field: "enabled" | "hidden" | "autoImport",
  ) => void;
  readonly onRequestDelete: (subscription: CalendarSubscription) => void;
  readonly onConfirmDelete: () => void;
  readonly onCancelDelete: () => void;
  readonly onHideEvent: (
    event: CalendarSubscriptionEvent,
    hidden: boolean,
  ) => void;
  readonly onConvertEvent: (event: CalendarSubscriptionEvent) => void;
}

/**
 * Read-only iCal subscriptions (ADR 0032): add a feed by address, see each
 * feed's host and freshness, and act on upcoming events. The address is
 * entered once and never shown again.
 */
export const CalendarSubscriptionsView = ({
  subscriptions,
  events,
  pendingDelete,
  busy,
  message,
  error,
  onCreate,
  onRefresh,
  onToggle,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
  onHideEvent,
  onConvertEvent,
}: CalendarSubscriptionsViewProps) => {
  const [referenceOnly, setReferenceOnly] = useState(false);
  const [autoImport, setAutoImport] = useState(false);
  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const value = (name: string): string => {
      const item = data.get(name);
      return typeof item === "string" ? item : "";
    };
    onCreate({
      name: value("name"),
      url: value("url"),
      refreshIntervalMinutes: value("refreshIntervalMinutes"),
      includePattern: value("includePattern"),
      excludePattern: value("excludePattern"),
      referenceOnly,
      autoImport,
    });
    event.currentTarget.reset();
    setReferenceOnly(false);
    setAutoImport(false);
  };
  return (
    <Card aria-labelledby="calendar-subscriptions-title">
      <CardHeader>
        <SectionHeading
          as="h3"
          id="calendar-subscriptions-title"
          eyebrow="Read-only feeds"
          title="Calendar subscriptions"
        />
      </CardHeader>
      <CardContent className="grid gap-4">
        <p>
          Subscribe to an iCal address (https or webcal). Tadooer fetches it on
          a schedule, shows the events in the planner and can turn an event into
          a task. Nothing is ever written to the calendar. The address may
          contain a private token: it is stored encrypted and only the host is
          shown here.
        </p>
        <p className="hint">
          Online only: subscriptions are not cached for offline use.
        </p>
        {message !== null && <p role="status">{message}</p>}
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <form
          className="grid gap-3"
          onSubmit={submit}
          aria-label="Add a calendar subscription"
        >
          <div className="grid gap-3 md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="subscription-name">Name</FieldLabel>
              <Input
                id="subscription-name"
                name="name"
                maxLength={100}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="subscription-url">
                Calendar address
              </FieldLabel>
              <Input
                id="subscription-url"
                name="url"
                type="url"
                inputMode="url"
                placeholder="https://… or webcal://…"
                autoComplete="off"
                required
              />
              <FieldDescription>
                Entered once; never shown again.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="subscription-interval">
                Refresh every (minutes)
              </FieldLabel>
              <Input
                id="subscription-interval"
                name="refreshIntervalMinutes"
                type="number"
                min={5}
                max={1440}
                defaultValue={120}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="subscription-include">
                Include titles matching
              </FieldLabel>
              <Input
                id="subscription-include"
                name="includePattern"
                maxLength={256}
              />
              <FieldDescription>
                Optional regular expression; empty keeps every event.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="subscription-exclude">
                Exclude titles matching
              </FieldLabel>
              <Input
                id="subscription-exclude"
                name="excludePattern"
                maxLength={256}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={referenceOnly}
              onCheckedChange={(checked) => setReferenceOnly(checked === true)}
            />
            Reference calendar: show events for context only, without tasks
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={autoImport}
              disabled={referenceOnly}
              onCheckedChange={(checked) => setAutoImport(checked === true)}
            />
            Create tasks for today's events automatically
          </label>
          <div>
            <Button type="submit" disabled={busy}>
              Subscribe
            </Button>
          </div>
        </form>
        {pendingDelete !== null && (
          <div role="alertdialog" aria-labelledby="subscription-delete-confirm">
            <p id="subscription-delete-confirm">
              Remove the subscription "{pendingDelete.name}" (
              {pendingDelete.urlHost})? Its saved events and hidden-event
              choices are deleted; tasks already created stay.
            </p>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={onConfirmDelete}
            >
              Remove subscription
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onCancelDelete}
            >
              Cancel
            </Button>
          </div>
        )}
        {subscriptions === null ? (
          error === null && <p>Loading calendar subscriptions…</p>
        ) : subscriptions.length === 0 ? (
          <p>No calendar subscriptions yet.</p>
        ) : (
          <ul className="grid gap-3">
            {subscriptions.map((subscription) => (
              <li key={subscription.id} className="grid gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{subscription.name}</strong>
                  <span>{subscription.urlHost}</span>
                  <Badge
                    variant={freshnessVariant(subscription.freshness.state)}
                  >
                    {subscription.freshness.state}
                  </Badge>
                  {!subscription.enabled && (
                    <Badge variant="outline">Paused</Badge>
                  )}
                  {subscription.hidden && (
                    <Badge variant="outline">Hidden</Badge>
                  )}
                  {subscription.referenceOnly && (
                    <Badge variant="outline">Reference</Badge>
                  )}
                  {subscription.autoImport && (
                    <Badge variant="info">Auto-import</Badge>
                  )}
                </div>
                <span className="text-sm">
                  {subscription.freshness.message} · {subscription.eventCount}{" "}
                  saved event
                  {subscription.eventCount === 1 ? "" : "s"} · every{" "}
                  {subscription.refreshIntervalMinutes} min
                </span>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => onRefresh(subscription)}
                  >
                    Refresh now
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => onToggle(subscription, "enabled")}
                  >
                    {subscription.enabled ? "Pause" : "Resume"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => onToggle(subscription, "hidden")}
                  >
                    {subscription.hidden
                      ? "Show in planner"
                      : "Hide from planner"}
                  </Button>
                  {!subscription.referenceOnly && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => onToggle(subscription, "autoImport")}
                    >
                      {subscription.autoImport
                        ? "Stop auto-import"
                        : "Auto-import today"}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={`Remove subscription ${subscription.name}`}
                    onClick={() => onRequestDelete(subscription)}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {subscriptions !== null && subscriptions.length > 0 && (
          <section
            aria-labelledby="subscription-events-title"
            className="grid gap-2"
          >
            <SectionHeading
              as="h3"
              id="subscription-events-title"
              title="Next 7 days"
            />
            {events.length === 0 ? (
              <p>No subscribed events in the next 7 days.</p>
            ) : (
              <ul className="grid gap-2">
                {events.map((event) => (
                  <li
                    key={`${event.subscriptionId}:${event.uid}:${event.occurrenceStart}`}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <span className="text-sm">{describeEventTime(event)}</span>
                    <strong
                      className={event.hidden ? "line-through" : undefined}
                    >
                      {event.summary === "" ? "(untitled)" : event.summary}
                    </strong>
                    <span className="text-sm">{event.subscriptionName}</span>
                    {event.taskId !== null && (
                      <Badge variant="success">Task created</Badge>
                    )}
                    {event.hidden && <Badge variant="outline">Hidden</Badge>}
                    {event.url !== null && (
                      <a
                        href={event.url}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        Open
                      </a>
                    )}
                    {!event.referenceOnly && event.taskId === null && (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={busy}
                        onClick={() => onConvertEvent(event)}
                      >
                        Add task
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={busy}
                      onClick={() => onHideEvent(event, !event.hidden)}
                    >
                      {event.hidden ? "Show" : "Hide"}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </CardContent>
    </Card>
  );
};

export const CalendarSubscriptions = ({
  csrfToken,
  api = defaultApi,
  now = defaultNow,
}: {
  readonly csrfToken: string;
  readonly api?: CalendarSubscriptionApi;
  readonly now?: () => Date;
}) => {
  const [subscriptions, setSubscriptions] = useState<
    readonly CalendarSubscription[] | null
  >(null);
  const [events, setEvents] = useState<readonly CalendarSubscriptionEvent[]>(
    [],
  );
  const [pendingDelete, setPendingDelete] =
    useState<CalendarSubscription | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let current = true;
    const window = upcomingWindow(now());
    Promise.all([api.list(), api.events(window.from, window.to)])
      .then(([list, upcoming]) => {
        if (!current) return;
        setSubscriptions(list.subscriptions);
        setEvents(upcoming.events);
      })
      .catch(() => {
        if (current) setError("Could not load calendar subscriptions.");
      });
    return () => {
      current = false;
    };
  }, [api, now, reloads]);
  const reload = () => setReloads((count) => count + 1);
  const run = async (work: () => Promise<string | null>, failure: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      setMessage(await work());
      reload();
    } catch {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <CalendarSubscriptionsView
      subscriptions={subscriptions}
      events={events}
      pendingDelete={pendingDelete}
      busy={busy}
      message={message}
      error={error}
      onCreate={(values) => {
        const input = createInputFromForm(values);
        if ("error" in input) {
          setError(input.error);
          return;
        }
        void run(async () => {
          const result = await api.create(input, csrfToken);
          return `Subscribed to ${result.subscription.urlHost}. ${describeFetch(result.fetch)}`;
        }, "Could not add that subscription. Check the address and try again.");
      }}
      onRefresh={(subscription) =>
        void run(async () => {
          const result = await api.refresh(subscription.id, csrfToken);
          return describeFetch(result.fetch);
        }, "Could not refresh that subscription.")
      }
      onToggle={(subscription, field) =>
        void run(async () => {
          await api.update(
            subscription.id,
            subscription.revision,
            { [field]: !subscription[field] },
            csrfToken,
          );
          return null;
        }, "Could not change that subscription. It may have changed; reload and try again.")
      }
      onRequestDelete={setPendingDelete}
      onCancelDelete={() => setPendingDelete(null)}
      onConfirmDelete={() => {
        if (pendingDelete === null) return;
        void run(async () => {
          await api.remove(pendingDelete.id, pendingDelete.revision, csrfToken);
          setPendingDelete(null);
          return "Subscription removed.";
        }, "Could not remove that subscription. It may have changed; reload and try again.");
      }}
      onHideEvent={(event, hidden) =>
        void run(async () => {
          await api.setHidden(event.subscriptionId, event, hidden, csrfToken);
          return null;
        }, "Could not change that event.")
      }
      onConvertEvent={(event) =>
        void run(async () => {
          const result = await api.convert(
            event.subscriptionId,
            event,
            csrfToken,
          );
          return result.replayed
            ? `"${result.task.title}" already exists as a task.`
            : `Created the task "${result.task.title}".`;
        }, "Could not create a task from that event.")
      }
    />
  );
};
