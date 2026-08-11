import { useEffect, useState, type SyntheticEvent } from "react";
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

const maximumCalendarFileBytes = 4 * 1024 * 1024;

export const calendarFileValidationError = (file: {
  readonly name: string;
  readonly size: number;
}): string | null => {
  if (!file.name.toLowerCase().endsWith(".ics"))
    return "Choose a calendar export whose filename ends in .ics.";
  if (file.size === 0) return "The selected calendar file is empty.";
  if (file.size > maximumCalendarFileBytes)
    return "The selected calendar file is larger than the 4 MiB import limit.";
  return null;
};

export const CalendarMigration = ({
  calendars,
  csrfToken,
}: {
  readonly calendars: readonly CalendarCollection[];
  readonly csrfToken: string;
}) => {
  const value = (data: FormData, name: string): string => {
    const item = data.get(name);
    return typeof item === "string" ? item : "";
  };
  const [preview, setPreview] = useState<CalendarImportJob | null>(null);
  const [feeds, setFeeds] = useState<readonly CalendarFeedCapability[]>([]);
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<{
    readonly name: string;
    readonly size: number;
    readonly rawIcs: string;
  } | null>(null);
  const [importActivity, setImportActivity] = useState<
    "reading" | "previewing" | "applying" | null
  >(null);
  useEffect(() => {
    void listCalendarFeeds().then(({ capabilities }) => setFeeds(capabilities));
  }, []);
  const previewImport = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    setImportError(null);
    if (selectedFile === null) {
      setImportError("Choose an .ics calendar file before previewing.");
      return;
    }
    const data = new FormData(event.currentTarget);
    setImportActivity("previewing");
    try {
      const result = await previewCalendarImport(
        {
          source: value(data, "source") as "ics" | "google_ics",
          calendarId: value(data, "calendarId"),
          rawIcs: selectedFile.rawIcs,
        },
        csrfToken,
      );
      setPreview(result.job);
      setMessage(
        `Previewed ${selectedFile.name}. Review the report before applying the one-time migration.`,
      );
    } catch (error: unknown) {
      setImportError(
        error instanceof Error ? error.message : "Calendar preview failed.",
      );
    } finally {
      setImportActivity(null);
    }
  };
  const selectCalendarFile = async (
    event: SyntheticEvent<HTMLInputElement>,
  ): Promise<void> => {
    const file = event.currentTarget.files?.[0];
    setPreview(null);
    setMessage(null);
    setImportError(null);
    setSelectedFile(null);
    if (file === undefined) return;
    const validationError = calendarFileValidationError(file);
    if (validationError !== null) {
      setImportError(validationError);
      event.currentTarget.value = "";
      return;
    }
    setImportActivity("reading");
    try {
      const rawIcs = await file.text();
      if (rawIcs.length > maximumCalendarFileBytes) {
        setImportError(
          "The decoded calendar file is larger than the 4 MiB import limit.",
        );
        event.currentTarget.value = "";
        return;
      }
      setSelectedFile({ name: file.name, size: file.size, rawIcs });
      setMessage(`${file.name} is ready to preview.`);
    } catch {
      setImportError("The browser could not read the selected calendar file.");
      event.currentTarget.value = "";
    } finally {
      setImportActivity(null);
    }
  };
  const applyImport = async (): Promise<void> => {
    if (preview?.state !== "previewed") return;
    setImportError(null);
    setMessage(
      `Importing ${String(preview.report.totals.ready)} events into Baïkal. Keep this page open; larger calendars can take several minutes.`,
    );
    setImportActivity("applying");
    try {
      const { job } = await applyCalendarImport(preview.id, csrfToken);
      setPreview(job);
      setMessage(
        `Applied ${String(job.items.filter(({ state }) => state === "applied").length)} events.`,
      );
    } catch (error: unknown) {
      setImportError(
        error instanceof Error
          ? `Import status could not be confirmed: ${error.message}`
          : "Import status could not be confirmed. Refresh and review before retrying.",
      );
    } finally {
      setImportActivity(null);
    }
  };
  const issueFeed = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const result = await createCalendarFeed(
      value(data, "calendarId"),
      value(data, "label"),
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
      <form
        className="calendar-import-form"
        aria-busy={importActivity !== null}
        onSubmit={(event) => void previewImport(event)}
      >
        <label className="field">
          <span>Source</span>
          <select name="source" disabled={importActivity !== null}>
            <option value="ics">iCalendar file</option>
            <option value="google_ics">Google Calendar ICS/Takeout</option>
          </select>
        </label>
        <label className="field">
          <span>Destination calendar</span>
          <select name="calendarId" required disabled={importActivity !== null}>
            {calendars.map((calendar) => (
              <option key={calendar.id} value={calendar.id}>
                {calendar.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Calendar file</span>
          <input
            name="calendarFile"
            type="file"
            accept=".ics,text/calendar"
            required
            disabled={importActivity !== null}
            aria-describedby="calendar-file-help"
            onChange={(event) => void selectCalendarFile(event)}
          />
        </label>
        <p id="calendar-file-help" className="hint">
          Choose one `.ics` export, up to 4 MiB. The browser reads it locally
          and sends it only when you preview the import.
        </p>
        {selectedFile !== null && (
          <p className="selected-file" role="status">
            <strong>{selectedFile.name}</strong>
            <span>{(selectedFile.size / 1024).toFixed(1)} KiB selected</span>
          </p>
        )}
        <button disabled={selectedFile === null || importActivity !== null}>
          {importActivity === "reading"
            ? "Reading file…"
            : importActivity === "previewing"
              ? "Building preview…"
              : "Preview import"}
        </button>
      </form>
      {importError !== null && (
        <p className="message message-error" role="alert">
          {importError}
        </p>
      )}
      {preview !== null && (
        <div
          className="import-preview"
          aria-busy={importActivity === "applying"}
        >
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
              disabled={importActivity !== null}
              onClick={() => void applyImport()}
            >
              {importActivity === "applying"
                ? "Importing into Baïkal…"
                : "Apply one-time migration"}
            </button>
          ) : (
            <p>Import state: {preview.state}</p>
          )}
        </div>
      )}
      {importActivity === "applying" && preview !== null && (
        <div className="import-progress" role="status" aria-live="polite">
          <progress aria-label="Calendar migration is in progress" />
          <strong>Migration in progress</strong>
          <span>
            Importing up to {preview.report.totals.ready} events. Keep this page
            open; the final count will appear when Baïkal finishes.
          </span>
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
        <p className="message message-success" role="status">
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
