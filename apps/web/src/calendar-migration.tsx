import { useEffect, useState, type FormEvent } from "react";
import type {
  CalendarCollection,
  CalendarFeedCapability,
  CalendarImportJob,
} from "@suite/contracts";
import {
  applyCalendarImport,
  createCalendarFeed,
  listCalendarFeeds,
  previewCalendarImport,
  revokeCalendarFeed,
} from "./api.ts";

export const CalendarMigration = ({
  calendars,
  csrfToken,
}: {
  readonly calendars: readonly CalendarCollection[];
  readonly csrfToken: string;
}) => {
  const [preview, setPreview] = useState<CalendarImportJob | null>(null);
  const [feeds, setFeeds] = useState<readonly CalendarFeedCapability[]>([]);
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    void listCalendarFeeds().then(({ capabilities }) => setFeeds(capabilities));
  }, []);
  const previewImport = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    const data = new FormData(event.currentTarget);
    const result = await previewCalendarImport(
      {
        source: String(data.get("source")) as "ics" | "google_ics",
        calendarId: String(data.get("calendarId")),
        rawIcs: String(data.get("rawIcs")),
      },
      csrfToken,
    );
    setPreview(result.job);
  };
  const issueFeed = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const result = await createCalendarFeed(
      String(data.get("calendarId")),
      String(data.get("label")),
      csrfToken,
    );
    setFeeds([...feeds, result.capability]);
    setIssuedUrl(result.url);
    setMessage(
      "Copy this capability URL now. Suite will not show its secret again.",
    );
  };
  return (
    <section className="migration-library" aria-labelledby="migration-heading">
      <h3 id="migration-heading">Migration & read-only publication</h3>
      <p className="hint">
        Preview a bounded ICS export before making a one-time copy into Baïkal.
        Google exports use the Google Calendar ICS/Takeout adapter; this is not
        live synchronization.
      </p>
      <form onSubmit={(event) => void previewImport(event)}>
        <label className="field">
          <span>Source</span>
          <select name="source">
            <option value="ics">iCalendar file</option>
            <option value="google_ics">Google Calendar ICS/Takeout</option>
          </select>
        </label>
        <label className="field">
          <span>Destination calendar</span>
          <select name="calendarId" required>
            {calendars.map((calendar) => (
              <option key={calendar.id} value={calendar.id}>
                {calendar.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>ICS contents</span>
          <textarea name="rawIcs" rows={8} required />
        </label>
        <button>Preview import</button>
      </form>
      {preview !== null && (
        <div className="import-preview" role="status">
          <p>
            <strong>{preview.report.totals.ready}</strong> events ready;{" "}
            {preview.report.totals.skipped} skipped;{" "}
            {preview.report.totals.recurring} recurring;{" "}
            {preview.report.totals.attendees} attendees;{" "}
            {preview.report.totals.alarms} alarms;{" "}
            {preview.report.totals.unknownProperties} unknown properties
            preserved.
          </p>
          <ul>
            {[
              ...preview.report.skipped,
              ...preview.report.candidates.flatMap(({ issues }) => issues),
            ].map((issue, index) => (
              <li key={`${issue.code}-${String(index)}`}>
                {issue.code}: {issue.detail}
              </li>
            ))}
          </ul>
          {preview.state === "previewed" ? (
            <button
              type="button"
              onClick={() =>
                void applyCalendarImport(preview.id, csrfToken).then(
                  ({ job }) => {
                    setPreview(job);
                    setMessage(
                      `Applied ${String(job.items.filter(({ state }) => state === "applied").length)} events.`,
                    );
                  },
                )
              }
            >
              Apply one-time migration
            </button>
          ) : (
            <p>Import state: {preview.state}</p>
          )}
        </div>
      )}
      <h4>Export and subscription feeds</h4>
      <ul>
        {calendars.map((calendar) => (
          <li key={calendar.id}>
            <a href={`/api/calendars/${calendar.id}/export.ics`}>
              Export {calendar.displayName} as ICS
            </a>
          </li>
        ))}
      </ul>
      <form onSubmit={(event) => void issueFeed(event)}>
        <label className="field">
          <span>Published calendar</span>
          <select name="calendarId" required>
            {calendars.map((calendar) => (
              <option key={calendar.id} value={calendar.id}>
                {calendar.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Feed label</span>
          <input name="label" required maxLength={100} />
        </label>
        <button>Create revocable read-only feed</button>
      </form>
      {issuedUrl !== null && (
        <output className="capability-url">
          {new URL(issuedUrl, window.location.href).href}
        </output>
      )}
      {message !== null && (
        <p className="success" role="status">
          {message}
        </p>
      )}
      <ul>
        {feeds.map((feed) => (
          <li key={feed.id}>
            {feed.label} · {feed.revokedAt === null ? "active" : "revoked"}
            {feed.revokedAt === null && (
              <button
                type="button"
                onClick={() =>
                  void revokeCalendarFeed(feed.id, csrfToken).then(() =>
                    setFeeds(
                      feeds.map((candidate) =>
                        candidate.id === feed.id
                          ? {
                              ...candidate,
                              revokedAt: new Date().toISOString(),
                            }
                          : candidate,
                      ),
                    ),
                  )
                }
              >
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
};
