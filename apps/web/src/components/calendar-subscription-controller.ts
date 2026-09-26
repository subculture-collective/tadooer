import type {
  CalendarSubscription,
  CalendarSubscriptionConversionResponse,
  CalendarSubscriptionCreateRequest,
  CalendarSubscriptionEvent,
  CalendarSubscriptionEventListResponse,
  CalendarSubscriptionEventMutationResponse,
  CalendarSubscriptionFetchResult,
  CalendarSubscriptionListResponse,
  CalendarSubscriptionMutationResponse,
  CalendarSubscriptionPatchRequest,
  CalendarSubscriptionRefreshResponse,
} from "@suite/contracts";

// Browser-side helpers for read-only iCal subscriptions (issue #91, ADR 0032).
// The API is injectable so the view logic is testable without a server.

export interface CalendarSubscriptionApi {
  readonly list: () => Promise<CalendarSubscriptionListResponse>;
  readonly create: (
    input: CalendarSubscriptionCreateRequest,
    csrfToken: string,
  ) => Promise<CalendarSubscriptionRefreshResponse>;
  readonly update: (
    id: string,
    revision: number,
    input: CalendarSubscriptionPatchRequest,
    csrfToken: string,
  ) => Promise<CalendarSubscriptionMutationResponse>;
  readonly remove: (
    id: string,
    revision: number,
    csrfToken: string,
  ) => Promise<void>;
  readonly refresh: (
    id: string,
    csrfToken: string,
  ) => Promise<CalendarSubscriptionRefreshResponse>;
  readonly events: (
    from: string,
    to: string,
  ) => Promise<CalendarSubscriptionEventListResponse>;
  readonly setHidden: (
    subscriptionId: string,
    event: { readonly uid: string; readonly occurrenceStart: string },
    hidden: boolean,
    csrfToken: string,
  ) => Promise<CalendarSubscriptionEventMutationResponse>;
  readonly convert: (
    subscriptionId: string,
    event: { readonly uid: string; readonly occurrenceStart: string },
    csrfToken: string,
  ) => Promise<CalendarSubscriptionConversionResponse>;
}

/** Upcoming-events window shown under the subscriptions: the next 7 days. */
export const upcomingWindow = (
  now: Date,
): { readonly from: string; readonly to: string } => ({
  from: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
  to: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
});

export const freshnessVariant = (
  state: CalendarSubscription["freshness"]["state"],
): "success" | "warning" | "destructive" | "outline" =>
  state === "fresh"
    ? "success"
    : state === "stale"
      ? "warning"
      : state === "unavailable"
        ? "destructive"
        : "outline";

const errorText: Readonly<Record<string, string>> = {
  blocked_address: "the address resolves to a blocked network location",
  dns_failed: "the host name could not be resolved",
  timeout: "the server did not answer in time",
  network_error: "the connection failed",
  too_large: "the feed is larger than 4 MiB",
  not_calendar: "the response is not an iCalendar document",
  key_unavailable: "the stored address cannot be decrypted on this server",
  too_many_redirects: "the address redirected too many times",
  redirect_invalid: "the address redirected somewhere invalid",
};

/** One line describing a fetch outcome; never the address. */
export const describeFetch = (
  fetch: CalendarSubscriptionFetchResult,
): string => {
  if (fetch.kind === "unchanged") return "The feed has not changed.";
  if (fetch.kind === "fetched") {
    const parts = [
      `Saved ${String(fetch.events)} event occurrence${fetch.events === 1 ? "" : "s"}`,
    ];
    if (fetch.counts.unsupportedRecurrence > 0)
      parts.push(
        `${String(fetch.counts.unsupportedRecurrence)} repeating series use rules Tadooer does not expand (first occurrence only)`,
      );
    if (fetch.counts.invalid > 0)
      parts.push(
        `${String(fetch.counts.invalid)} events were skipped as invalid`,
      );
    if (fetch.counts.truncated > 0)
      parts.push("the feed was truncated at the occurrence limit");
    return `${parts.join("; ")}.`;
  }
  const httpStatus = /^http_(\d{3})$/.exec(fetch.errorClass)?.[1];
  return `Fetch failed: ${
    httpStatus !== undefined
      ? `the server answered ${httpStatus}`
      : (errorText[fetch.errorClass] ?? fetch.errorClass)
  }.`;
};

const timeFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export const describeEventTime = (event: CalendarSubscriptionEvent): string =>
  event.allDay
    ? `${dayFormat.format(new Date(event.startsAt))} (all day)`
    : timeFormat.format(new Date(event.startsAt));

/** Persisted create input from the form's raw values. */
export const createInputFromForm = (values: {
  readonly name: string;
  readonly url: string;
  readonly refreshIntervalMinutes: string;
  readonly includePattern: string;
  readonly excludePattern: string;
  readonly referenceOnly: boolean;
  readonly autoImport: boolean;
}): CalendarSubscriptionCreateRequest | { readonly error: string } => {
  const name = values.name.trim();
  const url = values.url.trim();
  if (name === "") return { error: "Give the calendar a name." };
  if (url === "") return { error: "Enter the calendar address." };
  const interval = Number(values.refreshIntervalMinutes);
  if (!Number.isInteger(interval) || interval < 5 || interval > 1440)
    return { error: "Refresh every 5 to 1440 minutes." };
  return {
    name,
    url,
    refreshIntervalMinutes: interval,
    includePattern: values.includePattern.trim() || null,
    excludePattern: values.excludePattern.trim() || null,
    referenceOnly: values.referenceOnly,
    autoImport: values.autoImport && !values.referenceOnly,
  };
};
