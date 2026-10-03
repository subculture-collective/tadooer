import { useState, type SyntheticEvent } from "react";
import type {
  DayPlanResponse,
  GoogleConnectorStatusResponse,
  GoogleWriteRefusal,
  PlanningPreferences,
} from "@suite/contracts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SectionHeading } from "@/components/ui/section-heading";

export interface GooglePlanningProps {
  readonly status: GoogleConnectorStatusResponse;
  readonly preferences: PlanningPreferences;
  readonly dayPlan: DayPlanResponse;
  readonly busy: boolean;
  readonly onAuthorize: () => Promise<string>;
  readonly onSynchronize: (full?: boolean) => Promise<void>;
  readonly onDisconnect: () => Promise<void>;
  readonly onSavePreferences: (
    preferences: PlanningPreferences,
  ) => Promise<void>;
  readonly mode?: "all" | "connection" | "preferences";
  /** ADR 0040: explicit write consent; omitted where only reads are shown. */
  readonly onAuthorizeWrite?: () => Promise<string>;
  readonly onWithdrawWrite?: () => Promise<void>;
}

const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const writeRefusalLabels: Record<GoogleWriteRefusal, string> = {
  "not-connected": "not connected",
  "reconnect-required": "reconnect required",
  "consent-required": "event changes not allowed",
  "scope-missing": "Google no longer allows event changes",
  "role-unknown": "permissions not synced yet",
  "read-only-calendar": "read only in Google",
};

const GoogleWriteAccess = ({
  status,
  busy,
  onAuthorizeWrite,
  onWithdrawWrite,
}: {
  readonly status: GoogleConnectorStatusResponse;
  readonly busy: boolean;
  readonly onAuthorizeWrite: () => Promise<string>;
  readonly onWithdrawWrite: () => Promise<void>;
}) => {
  const [writeUrl, setWriteUrl] = useState<string | null>(null);
  const { consent, consentedAt } = status.write;
  const allow = (
    <Button
      type="button"
      variant="ghost"
      disabled={busy}
      onClick={() =>
        void onAuthorizeWrite()
          .then(setWriteUrl)
          .catch(() => undefined)
      }
    >
      {consent === "lost" ? "Allow event changes again" : "Allow event changes"}
    </Button>
  );
  const withdraw = (
    <Button
      type="button"
      variant="ghost"
      disabled={busy}
      onClick={() => void onWithdrawWrite()}
    >
      Withdraw event changes
    </Button>
  );
  return (
    <div className="google-write-access" aria-labelledby="google-write-title">
      <h4 id="google-write-title">Event changes</h4>
      {consent === "none" && (
        <p className="muted">
          Tadooer has read-only access. Allowing event changes asks Google for
          permission to create, change and delete events on calendars you can
          edit. Calendars that are read-only in Google stay read-only.
        </p>
      )}
      {consent === "granted" && (
        <p className="message message-info">
          Event changes allowed
          {consentedAt === null ? "" : " since "}
          {consentedAt !== null && (
            <time dateTime={consentedAt}>{consentedAt.slice(0, 10)}</time>
          )}
          . Tadooer writes only to calendars marked writable below.
        </p>
      )}
      {consent === "lost" && (
        <p className="message message-error" role="alert">
          Google no longer allows event changes. Your calendars and saved events
          are kept; writes are refused until you allow event changes again.
        </p>
      )}
      <div className="task-actions">
        {consent !== "granted" && allow}
        {consent !== "none" && withdraw}
      </div>
      {consent !== "none" && (
        <p className="hint">
          Withdrawing stops Tadooer writes immediately. Google keeps the
          permission until you disconnect or remove access in your Google
          account.
        </p>
      )}
      {writeUrl !== null && (
        <p>
          <a
            className="button-link"
            href={writeUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            Review event-change permission in your system browser
          </a>
        </p>
      )}
    </div>
  );
};

export const GooglePlanning = ({
  status,
  preferences,
  dayPlan,
  busy,
  onAuthorize,
  onSynchronize,
  onDisconnect,
  onSavePreferences,
  mode = "all",
  onAuthorizeWrite,
  onWithdrawWrite,
}: GooglePlanningProps) => {
  const [days, setDays] = useState<readonly number[]>(preferences.workingDays);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const submitPreferences = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const value = (name: string): string => {
      const item = data.get(name);
      return typeof item === "string" ? item : "";
    };
    const breakStart = value("breakStart");
    const breakEnd = value("breakEnd");
    const dayStartsAt = value("dayStartsAt");
    void onSavePreferences({
      workingDays: [...days],
      workdayStart: value("workdayStart"),
      workdayEnd: value("workdayEnd"),
      breakStart: breakStart === "" ? null : breakStart,
      breakEnd: breakEnd === "" ? null : breakEnd,
      timeZone: value("timeZone"),
      // ADR 0027: an empty field keeps local midnight.
      dayStartsAt: dayStartsAt === "" ? "00:00" : dayStartsAt,
    });
  };

  return (
    <section
      className="google-planning"
      aria-labelledby="google-planning-title"
    >
      <SectionHeading
        as="h3"
        id="google-planning-title"
        eyebrow={mode === "preferences" ? "Planning" : "Calendar connection"}
        title={
          mode === "preferences"
            ? "Working hours and time zone"
            : "Google Calendar"
        }
        actions={
          <span
            className={`freshness freshness--${status.connected ? status.state : "unavailable"}`}
          >
            {status.state.replaceAll("_", " ")}
          </span>
        }
      />
      {mode !== "preferences" &&
        (!status.configured ? (
          <p className="muted">
            Google credentials are not installed on this server. Baïkal and your
            tasks work without them.
          </p>
        ) : !status.connected ? (
          <div>
            <p className="muted">
              Connecting opens Google in your system browser and asks for
              read-only calendar access. Tadooer stores the grant encrypted on
              the server.
            </p>
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                void onAuthorize()
                  .then(setAuthorizationUrl)
                  .catch(() => undefined)
              }
            >
              {status.state === "reconnect_required"
                ? "Reconnect Google Calendar"
                : "Connect Google Calendar"}
            </Button>
            {authorizationUrl !== null && (
              <p>
                <a
                  className="button-link"
                  href={authorizationUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Continue authorization in your system browser
                </a>
              </p>
            )}
          </div>
        ) : (
          <div>
            <p className="message message-success">
              Google Calendar is connected
              {status.accountLabel === null
                ? "."
                : ` as ${status.accountLabel}.`}
            </p>
            <ul className="compact-list">
              {status.calendars.map((calendar) => {
                const freshness = status.freshness.find(
                  (item) => item.calendarId === calendar.id,
                );
                const capability = status.capabilities.find(
                  (item) => item.calendarId === calendar.id,
                );
                return (
                  <li key={calendar.id}>
                    <strong>{calendar.displayName}</strong>{" "}
                    <span>{freshness?.message ?? "Not read yet"}</span>{" "}
                    {capability !== undefined && (
                      <span
                        className="hint"
                        data-writable={capability.writable ? "true" : "false"}
                      >
                        {capability.writable
                          ? "Writable"
                          : `Read only (${writeRefusalLabels[capability.reason ?? "role-unknown"]})`}
                      </span>
                    )}
                    <p className="hint">
                      {freshness?.lastSuccessfulSyncAt ? (
                        <>
                          Last successful sync:{" "}
                          <time dateTime={freshness.lastSuccessfulSyncAt}>
                            {new Intl.DateTimeFormat("en-US", {
                              dateStyle: "medium",
                              timeStyle: "short",
                              timeZone: preferences.timeZone,
                            }).format(new Date(freshness.lastSuccessfulSyncAt))}
                          </time>{" "}
                          ({preferences.timeZone})
                        </>
                      ) : (
                        "Never synced"
                      )}
                    </p>
                  </li>
                );
              })}
            </ul>
            {onAuthorizeWrite !== undefined &&
              onWithdrawWrite !== undefined && (
                <GoogleWriteAccess
                  status={status}
                  busy={busy}
                  onAuthorizeWrite={onAuthorizeWrite}
                  onWithdrawWrite={onWithdrawWrite}
                />
              )}
            <p className="hint">
              Google refresh is currently manual. A recent sync is considered
              fresh for fifteen minutes. Resync reloads your calendars and
              events using the existing Google connection. The events already
              saved stay available if the resync fails.
            </p>
            <div className="task-actions">
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => void onSynchronize()}
              >
                Sync Google now
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => void onSynchronize(true)}
              >
                Resync Google Calendar
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={busy}
                onClick={() => void onDisconnect()}
              >
                Disconnect Google
              </Button>
            </div>
          </div>
        ))}

      {mode === "all" && (
        <div className="day-plan-summary" role="status">
          <strong>Today: {dayPlan.state.replaceAll("_", " ")}</strong>
          {dayPlan.nextTask === null ? (
            <span>Nothing is scheduled next.</span>
          ) : (
            <span>Next: {dayPlan.nextTask.title}</span>
          )}
          <span>
            Reminder: {dayPlan.reminder.suppressed ? "quiet" : "ready"} (
            {dayPlan.reminder.reason.replaceAll("_", " ")})
          </span>
        </div>
      )}

      {mode !== "connection" && (
        <Collapsible defaultOpen={mode === "preferences"}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" type="button">
              Working hours and quiet break
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <form className="planning-preferences" onSubmit={submitPreferences}>
              <fieldset>
                <legend>Working days</legend>
                {dayNames.map((name, day) => (
                  <Field key={name} className="flex-row items-center gap-2">
                    <Checkbox
                      id={`working-day-${String(day)}`}
                      checked={days.includes(day)}
                      onCheckedChange={(checked) =>
                        setDays((current) =>
                          checked === true
                            ? [...current, day].toSorted()
                            : current.filter((candidate) => candidate !== day),
                        )
                      }
                    />
                    <FieldLabel htmlFor={`working-day-${String(day)}`}>
                      {name}
                    </FieldLabel>
                  </Field>
                ))}
              </fieldset>
              <Field>
                <FieldLabel htmlFor="workday-start">Work starts</FieldLabel>
                <Input
                  id="workday-start"
                  name="workdayStart"
                  type="time"
                  defaultValue={preferences.workdayStart}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="workday-end">Work ends</FieldLabel>
                <Input
                  id="workday-end"
                  name="workdayEnd"
                  type="time"
                  defaultValue={preferences.workdayEnd}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="break-start">
                  Quiet break starts
                </FieldLabel>
                <Input
                  id="break-start"
                  name="breakStart"
                  type="time"
                  defaultValue={preferences.breakStart ?? ""}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="break-end">Quiet break ends</FieldLabel>
                <Input
                  id="break-end"
                  name="breakEnd"
                  type="time"
                  defaultValue={preferences.breakEnd ?? ""}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="time-zone">Time zone</FieldLabel>
                <Input
                  id="time-zone"
                  name="timeZone"
                  defaultValue={preferences.timeZone}
                  list="suite-time-zones"
                  required
                  autoComplete="off"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="day-starts-at">
                  New day starts at
                </FieldLabel>
                <Input
                  id="day-starts-at"
                  name="dayStartsAt"
                  type="time"
                  defaultValue={preferences.dayStartsAt ?? "00:00"}
                  aria-describedby="day-starts-at-hint"
                />
              </Field>
              <p className="hint" id="day-starts-at-hint">
                Before this time, Today still shows the previous day. Use 00:00
                for midnight.
              </p>
              <datalist id="suite-time-zones">
                <option value="America/Chicago" />
                <option value="America/New_York" />
                <option value="America/Denver" />
                <option value="America/Los_Angeles" />
                <option value="UTC" />
              </datalist>
              <p className="hint">
                Use an IANA time zone such as America/Chicago. Day boundaries
                and daylight-saving transitions follow this setting.
              </p>
              <Button disabled={busy || days.length === 0}>
                Save planning hours
              </Button>
            </form>
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  );
};
