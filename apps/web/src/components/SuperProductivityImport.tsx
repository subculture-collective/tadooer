import { useState } from "react";
import type { SuperProductivityPreview } from "@suite/contracts";
import { previewTaskImport } from "../api.ts";

export const SuperProductivityImport = ({
  csrfToken,
}: {
  readonly csrfToken: string;
}) => {
  const [raw, setRaw] = useState<string | null>(null);
  const [report, setReport] = useState<SuperProductivityPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const choose = async (file: File | undefined) => {
    setRaw(null);
    setReport(null);
    setError(null);
    if (file === undefined) return;
    if (file.size > 4 * 1024 * 1024) {
      setError(
        "This preview supports exports up to 4 MiB. Keep your full export; do not remove history to fit the limit.",
      );
      return;
    }
    setBusy(true);
    try {
      setRaw(await file.text());
    } catch {
      setError("Could not read that file.");
    } finally {
      setBusy(false);
    }
  };
  const preview = async () => {
    if (raw === null) return;
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      setReport(await previewTaskImport(raw, csrfToken));
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : "Preview failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="sp-import-title">
      <h3 id="sp-import-title">Super Productivity migration preview</h3>
      <p>
        Inspect a JSON backup before moving your tasks. This preview does not
        import or modify data.
      </p>
      <label>
        Super Productivity export{" "}
        <input
          type="file"
          accept=".json,application/json"
          disabled={busy}
          onChange={(event) => void choose(event.currentTarget.files?.[0])}
        />
      </label>
      <p className="hint">
        The file stays in this browser until you preview it. Preview sends it to
        your Tadooer server. Keep the original backup.
      </p>
      <button
        type="button"
        disabled={busy || raw === null}
        onClick={() => void preview()}
      >
        {busy ? "Reading export…" : "Preview Super Productivity export"}
      </button>
      {error !== null && <p role="alert">{error}</p>}
      {report !== null && (
        <div aria-live="polite">
          <p>
            {report.totals.tasks} tasks · {report.totals.completed} completed ·{" "}
            {report.totals.archived} archived · {report.totals.childTasks} child
            tasks
          </p>
          <p>
            {report.totals.projects} projects · {report.totals.tags} tags ·{" "}
            {report.totals.repeatConfigurations} repeat configurations
          </p>
          <p>
            Tracked time on leaf tasks:{" "}
            {report.totals.trackedMilliseconds.toLocaleString()} milliseconds.
            Parent totals may include child time.
          </p>
          <h4>Migration readiness</h4>
          <ul>
            {report.issues.map((issue, index) => (
              <li key={`${issue.code}:${String(index)}`}>
                {issue.sourceId === null ? "" : `${issue.sourceId}: `}
                {issue.detail}
              </li>
            ))}
          </ul>
          <details>
            <summary>Inspect task inventory</summary>
            <ul>
              {report.tasks.map((task) => (
                <li key={task.sourceId}>
                  {task.title} —{" "}
                  {task.archived
                    ? "archived"
                    : task.completed
                      ? "completed"
                      : "open"}
                  {task.parentId === null ? "" : " · child task"}
                </li>
              ))}
            </ul>
          </details>
          <p className="hint">
            Source fingerprint: <code>{report.inputHash}</code>
          </p>
        </div>
      )}
    </section>
  );
};
