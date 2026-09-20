import { useState } from "react";
import {
  superProductivityImportLimits as limits,
  type SuperProductivityPreview,
} from "@suite/contracts";
import { applyTaskImport, previewTaskImport } from "../api.ts";

export const SuperProductivityImport = ({
  csrfToken,
  onApplied,
}: {
  readonly csrfToken: string;
  readonly onApplied: () => Promise<void>;
}) => {
  const [raw, setRaw] = useState<string | null>(null);
  const [report, setReport] = useState<SuperProductivityPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const choose = async (file: File | undefined) => {
    setRaw(null);
    setOutcome(null);
    setApproved(false);
    setReport(null);
    setError(null);
    if (file === undefined) return;
    if (file.size > limits.bytes) {
      setError(
        `This preview supports exports up to ${limits.label}. Keep your full export; do not remove history to fit the limit.`,
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
  const apply = async () => {
    if (raw === null || report?.canApply !== true || !approved) return;
    setBusy(true);
    setError(null);
    try {
      const result = await applyTaskImport(raw, report.inputHash, csrfToken);
      setOutcome(
        `Import saved: ${String(result.created)} records created; ${String(result.existing)} previously imported records left unchanged.`,
      );
      setApproved(false);
      await onApplied();
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="sp-import-title">
      <h3 id="sp-import-title">Super Productivity migration</h3>
      <p>
        Preview a JSON backup before importing core tasks, projects, tags,
        notes, exact scheduled times, deadlines, estimates, and completion
        dates. Preview changes nothing. Unsupported workflows block the entire
        import.
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
        your Tadooer server. Limit: {limits.label},{" "}
        {limits.records.toLocaleString()} records. Keep the original backup.
      </p>
      <button
        type="button"
        disabled={busy || raw === null}
        onClick={() => void preview()}
      >
        {busy ? "Reading export…" : "Preview Super Productivity export"}
      </button>
      {outcome !== null && <p role="status">{outcome}</p>}
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
          {report.canApply && (
            <p>
              This export is ready for the initial core-data import. Source
              settings, integrations, and other application configuration are
              not imported. Keep the original backup.
            </p>
          )}
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
          {report.canApply && (
            <div>
              <label>
                <input
                  type="checkbox"
                  checked={approved}
                  disabled={busy}
                  onChange={(event) => setApproved(event.currentTarget.checked)}
                />{" "}
                I reviewed the inventory and want to import these records.
              </label>
              <button
                type="button"
                disabled={busy || !approved}
                onClick={() => void apply()}
              >
                Import reviewed records
              </button>
            </div>
          )}
          <p className="hint">
            Source fingerprint: <code>{report.inputHash}</code>
          </p>
        </div>
      )}
    </section>
  );
};
