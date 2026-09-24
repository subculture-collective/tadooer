import { useState } from "react";
import {
  superProductivityImportLimits as limits,
  type SuperProductivityPreview,
} from "@suite/contracts";
import { applyTaskImport, previewTaskImport } from "../api.ts";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
      <SectionHeading
        as="h3"
        id="sp-import-title"
        title="Super Productivity migration"
      />
      <p>
        Preview a JSON backup before importing core tasks, projects, tags,
        notes, exact scheduled times, deadlines, estimates, and completion
        dates. Preview changes nothing. Unsupported workflows block the entire
        import.
      </p>
      <Field>
        <FieldLabel htmlFor="sp-import-file">
          Super Productivity export
        </FieldLabel>
        <Input
          id="sp-import-file"
          type="file"
          accept=".json,application/json"
          disabled={busy}
          onChange={(event) => void choose(event.currentTarget.files?.[0])}
        />
      </Field>
      <p className="hint">
        The file stays in this browser until you preview it. Preview sends it to
        your Tadooer server. Limit: {limits.label},{" "}
        {limits.records.toLocaleString()} records. Keep the original backup.
      </p>
      <Button
        type="button"
        disabled={busy || raw === null}
        onClick={() => void preview()}
      >
        {busy ? "Reading export…" : "Preview Super Productivity export"}
      </Button>
      {outcome !== null && <p role="status">{outcome}</p>}
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
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
          <Collapsible>
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost">
                Inspect task inventory
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
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
            </CollapsibleContent>
          </Collapsible>
          {report.canApply && (
            <div>
              <Field className="flex-row items-center gap-2">
                <Checkbox
                  id="sp-import-approved"
                  checked={approved}
                  disabled={busy}
                  onCheckedChange={(checked) => setApproved(checked === true)}
                />
                <FieldLabel htmlFor="sp-import-approved">
                  I reviewed the inventory and want to import these records.
                </FieldLabel>
              </Field>
              <Button
                type="button"
                disabled={busy || !approved}
                onClick={() => void apply()}
              >
                Import reviewed records
              </Button>
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
