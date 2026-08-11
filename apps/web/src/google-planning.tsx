import { useState, type SyntheticEvent } from "react";
import type {
  DayPlanResponse,
  GoogleConnectorStatusResponse,
  PlanningPreferences,
} from "@suite/contracts";

export interface GooglePlanningProps {
  readonly status: GoogleConnectorStatusResponse;
  readonly preferences: PlanningPreferences;
  readonly dayPlan: DayPlanResponse;
  readonly busy: boolean;
  readonly onAuthorize: () => Promise<string>;
  readonly onSynchronize: () => Promise<void>;
  readonly onDisconnect: () => Promise<void>;
  readonly onSavePreferences: (
    preferences: PlanningPreferences,
  ) => Promise<void>;
  readonly mode?: "all" | "connection" | "preferences";
}

const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
    void onSavePreferences({
      workingDays: [...days],
      workdayStart: value("workdayStart"),
      workdayEnd: value("workdayEnd"),
      breakStart: breakStart === "" ? null : breakStart,
      breakEnd: breakEnd === "" ? null : breakEnd,
      timeZone: value("timeZone"),
    });
  };

  return (
    <section
      className="google-planning"
      aria-labelledby="google-planning-title"
    >
      <div className="section-heading">
        <div>
          <p className="step">
            {mode === "preferences"
              ? "Civil-time planning"
              : "Federated calendar context"}
          </p>
          <h3 id="google-planning-title">
            {mode === "preferences"
              ? "Working hours and time zone"
              : "Google Calendar"}
          </h3>
        </div>
        <span
          className={`freshness freshness--${status.connected ? status.state : "unavailable"}`}
        >
          {status.state.replaceAll("_", " ")}
        </span>
      </div>
      {mode !== "preferences" &&
        (!status.configured ? (
          <p className="muted">
            Google OAuth credentials are not installed yet. Baïkal and local
            tasks continue to work normally.
          </p>
        ) : !status.connected ? (
          <div>
            <p className="muted">
              Connect read-only calendar access in your system browser. The
              Suite stores the refresh grant encrypted on the server.
            </p>
            <button
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
            </button>
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
                return (
                  <li key={calendar.id}>
                    <strong>{calendar.displayName}</strong>{" "}
                    <span>
                      {freshness?.message ?? "Awaiting first projection"}
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="task-actions">
              <button
                type="button"
                className="btn-ghost"
                disabled={busy}
                onClick={() => void onSynchronize()}
              >
                Sync Google now
              </button>
              <button
                type="button"
                className="btn-danger"
                disabled={busy}
                onClick={() => void onDisconnect()}
              >
                Disconnect Google
              </button>
            </div>
          </div>
        ))}

      {mode === "all" && (
        <div className="day-plan-summary" role="status">
          <strong>Today: {dayPlan.state.replaceAll("_", " ")}</strong>
          {dayPlan.nextTask === null ? (
            <span>No scheduled task is ready next.</span>
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
        <details open={mode === "preferences"}>
          <summary>Working hours and quiet break</summary>
          <form className="planning-preferences" onSubmit={submitPreferences}>
            <fieldset>
              <legend>Working days</legend>
              {dayNames.map((name, day) => (
                <label key={name}>
                  <input
                    type="checkbox"
                    checked={days.includes(day)}
                    onChange={(event) =>
                      setDays((current) =>
                        event.currentTarget.checked
                          ? [...current, day].toSorted()
                          : current.filter((candidate) => candidate !== day),
                      )
                    }
                  />
                  {name}
                </label>
              ))}
            </fieldset>
            <label>
              Work starts
              <input
                name="workdayStart"
                type="time"
                defaultValue={preferences.workdayStart}
                required
              />
            </label>
            <label>
              Work ends
              <input
                name="workdayEnd"
                type="time"
                defaultValue={preferences.workdayEnd}
                required
              />
            </label>
            <label>
              Quiet break starts
              <input
                name="breakStart"
                type="time"
                defaultValue={preferences.breakStart ?? ""}
              />
            </label>
            <label>
              Quiet break ends
              <input
                name="breakEnd"
                type="time"
                defaultValue={preferences.breakEnd ?? ""}
              />
            </label>
            <label>
              Time zone
              <input
                name="timeZone"
                defaultValue={preferences.timeZone}
                list="suite-time-zones"
                required
                autoComplete="off"
              />
            </label>
            <datalist id="suite-time-zones">
              <option value="America/Chicago" />
              <option value="America/New_York" />
              <option value="America/Denver" />
              <option value="America/Los_Angeles" />
              <option value="UTC" />
            </datalist>
            <p className="hint">
              Use an IANA time zone such as America/Chicago. Day boundaries and
              daylight-saving transitions follow this setting.
            </p>
            <button disabled={busy || days.length === 0}>
              Save planning hours
            </button>
          </form>
        </details>
      )}
    </section>
  );
};
