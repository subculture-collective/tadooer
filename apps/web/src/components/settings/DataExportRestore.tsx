import { useState } from "react";
import {
  dataRestoreLimits as limits,
  type DataRestoreApplyResponse,
  type DataRestorePreview,
} from "@suite/contracts";
import {
  applyDataRestore,
  downloadDataExport,
  previewDataRestore,
} from "../../api.ts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SectionHeading } from "@/components/ui/section-heading";

/**
 * Owner data export and restore (issue #93, ADR 0034). The export downloads
 * the server's copy of the owner's data as one JSON file. A restore is
 * previewed first; applying needs an explicit confirmation, and a target that
 * already has data also needs the explicit replace choice.
 */

const saveFile = (name: string, text: string): void => {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
};

const rowCount = (counts: DataRestorePreview["counts"], table: string) =>
  counts.find((entry) => entry.table === table)?.rows ?? 0;

const summaryTables: readonly {
  readonly table: string;
  readonly label: string;
}[] = [
  { table: "tasks", label: "tasks" },
  { table: "projects", label: "projects" },
  { table: "tags", label: "tags" },
  { table: "notes", label: "notes" },
  { table: "time_entries", label: "time entries" },
  { table: "recurring_series", label: "recurring series" },
  { table: "habits", label: "habits" },
  { table: "counters", label: "counters" },
  { table: "boards", label: "boards" },
  { table: "task_templates", label: "templates" },
];

export const outcomeMessage = (result: DataRestoreApplyResponse): string =>
  `${result.mode === "replace" ? `Replaced ${String(result.deletedRows)} existing rows and restored` : "Restored"} ${String(result.totalRows)} rows. Reconnect calendars, iCal subscriptions and assistant credentials on this server; other devices will resynchronize.`;

export interface DataExportRestoreViewProps {
  readonly busy: boolean;
  readonly online: boolean;
  readonly exportError: string | null;
  readonly fileName: string | null;
  readonly preview: DataRestorePreview | null;
  readonly restoreError: string | null;
  readonly outcome: string | null;
  readonly approved: boolean;
  readonly replaceChosen: boolean;
  readonly onExport: () => void;
  readonly onChooseFile: (file: File | undefined) => void;
  readonly onPreview: () => void;
  readonly onApprove: (checked: boolean) => void;
  readonly onChooseReplace: (checked: boolean) => void;
  readonly onApply: () => void;
}

export const DataExportRestoreView = ({
  busy,
  online,
  exportError,
  fileName,
  preview,
  restoreError,
  outcome,
  approved,
  replaceChosen,
  onExport,
  onChooseFile,
  onPreview,
  onApprove,
  onChooseReplace,
  onApply,
}: DataExportRestoreViewProps) => {
  const needsReplace = preview !== null && !preview.target.empty;
  const canApply =
    preview?.canApply === true && approved && (!needsReplace || replaceChosen);
  return (
    <Card aria-labelledby="data-export-title">
      <CardHeader>
        <SectionHeading
          as="h3"
          id="data-export-title"
          title="Data export and restore"
        />
      </CardHeader>
      <CardContent className="grid gap-3">
        <p>
          Download a copy of your Tadooer data as one JSON file: tasks,
          projects, tags, notes, history, time entries, recurring series,
          habits, counters, boards, templates and preferences. The file contains
          no passwords, sessions, assistant credentials, calendar connector
          secrets or iCal subscription addresses; those are set up again on a
          restored server.
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={busy || !online}
          onClick={onExport}
        >
          Download data export
        </Button>
        {exportError !== null && (
          <Alert variant="destructive">
            <AlertDescription>{exportError}</AlertDescription>
          </Alert>
        )}
        <Field>
          <FieldLabel htmlFor="data-restore-file">
            Restore from a Tadooer export
          </FieldLabel>
          <Input
            id="data-restore-file"
            type="file"
            accept=".json,application/json"
            disabled={busy || !online}
            onChange={(event) => onChooseFile(event.currentTarget.files?.[0])}
          />
        </Field>
        <p className="hint">
          The file stays in this browser until you preview it. Preview changes
          nothing. Limit: {limits.label}. Operator SQLite backups are separate
          and are restored by the operator.
        </p>
        <Button
          type="button"
          disabled={busy || !online || fileName === null}
          onClick={onPreview}
        >
          {busy ? "Working…" : "Preview restore"}
        </Button>
        {outcome !== null && <p role="status">{outcome}</p>}
        {restoreError !== null && (
          <Alert variant="destructive">
            <AlertDescription>{restoreError}</AlertDescription>
          </Alert>
        )}
        {preview !== null && (
          <div aria-live="polite" className="grid gap-2">
            <p>
              Export from {preview.owner.username} on{" "}
              {preview.exportedAt.slice(0, 10)}
              {preview.sameInstance
                ? " (this server)"
                : " (another server)"}: {String(preview.totalRows)} rows.{" "}
              {summaryTables
                .map(
                  ({ table, label }) =>
                    `${String(rowCount(preview.counts, table))} ${label}`,
                )
                .join(" · ")}
              .
            </p>
            {preview.target.empty ? (
              <p>This account has no data yet; the export fills it.</p>
            ) : (
              <p>
                This account already has {String(preview.target.totalRows)}{" "}
                rows. Restoring replaces all of them; nothing is merged.
              </p>
            )}
            {preview.issues.length > 0 && (
              <ul>
                {preview.issues.map((issue, index) => (
                  <li key={`${issue.code}:${String(index)}`}>{issue.detail}</li>
                ))}
              </ul>
            )}
            {preview.canApply && (
              <div className="grid gap-2">
                {needsReplace && (
                  <Field className="flex-row items-center gap-2">
                    <Checkbox
                      id="data-restore-replace"
                      checked={replaceChosen}
                      disabled={busy}
                      onCheckedChange={(checked) =>
                        onChooseReplace(checked === true)
                      }
                    />
                    <FieldLabel htmlFor="data-restore-replace">
                      Replace all existing data in this account with the export.
                    </FieldLabel>
                  </Field>
                )}
                <Field className="flex-row items-center gap-2">
                  <Checkbox
                    id="data-restore-approved"
                    checked={approved}
                    disabled={busy}
                    onCheckedChange={(checked) => onApprove(checked === true)}
                  />
                  <FieldLabel htmlFor="data-restore-approved">
                    I reviewed the preview and want to restore this export.
                  </FieldLabel>
                </Field>
                <Button
                  type="button"
                  disabled={busy || !canApply}
                  onClick={onApply}
                >
                  {needsReplace ? "Replace and restore" : "Restore export"}
                </Button>
              </div>
            )}
            <p className="hint">
              File fingerprint: <code>{preview.inputHash}</code>
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export const DataExportRestore = ({
  csrfToken,
  online,
  onRestored,
}: {
  readonly csrfToken: string;
  readonly online: boolean;
  readonly onRestored: () => Promise<void>;
}) => {
  const [busy, setBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<DataRestorePreview | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  const [replaceChosen, setReplaceChosen] = useState(false);

  const exportData = async () => {
    setBusy(true);
    setExportError(null);
    try {
      const { filename, text } = await downloadDataExport();
      saveFile(filename, text);
    } catch (error: unknown) {
      setExportError(error instanceof Error ? error.message : "Export failed");
    } finally {
      setBusy(false);
    }
  };
  const choose = async (file: File | undefined) => {
    setRaw(null);
    setFileName(null);
    setPreview(null);
    setOutcome(null);
    setRestoreError(null);
    setApproved(false);
    setReplaceChosen(false);
    if (file === undefined) return;
    if (file.size > limits.bytes) {
      setRestoreError(`Restore supports exports up to ${limits.label}.`);
      return;
    }
    setBusy(true);
    try {
      setRaw(await file.text());
      setFileName(file.name);
    } catch {
      setRestoreError("Could not read that file.");
    } finally {
      setBusy(false);
    }
  };
  const runPreview = async () => {
    if (raw === null) return;
    setBusy(true);
    setRestoreError(null);
    setPreview(null);
    setApproved(false);
    setReplaceChosen(false);
    try {
      setPreview(await previewDataRestore(raw, csrfToken));
    } catch (error: unknown) {
      setRestoreError(
        error instanceof Error ? error.message : "Preview failed",
      );
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (raw === null || preview?.canApply !== true || !approved) return;
    const mode = preview.target.empty ? "empty-only" : "replace";
    if (mode === "replace" && !replaceChosen) return;
    setBusy(true);
    setRestoreError(null);
    try {
      const result = await applyDataRestore(
        raw,
        preview.inputHash,
        mode,
        csrfToken,
      );
      setOutcome(outcomeMessage(result));
      setPreview(null);
      setApproved(false);
      setReplaceChosen(false);
      await onRestored();
    } catch (error: unknown) {
      setRestoreError(
        error instanceof Error ? error.message : "Restore failed",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <DataExportRestoreView
      busy={busy}
      online={online}
      exportError={exportError}
      fileName={fileName}
      preview={preview}
      restoreError={restoreError}
      outcome={outcome}
      approved={approved}
      replaceChosen={replaceChosen}
      onExport={() => void exportData()}
      onChooseFile={(file) => void choose(file)}
      onPreview={() => void runPreview()}
      onApprove={setApproved}
      onChooseReplace={setReplaceChosen}
      onApply={() => void apply()}
    />
  );
};
