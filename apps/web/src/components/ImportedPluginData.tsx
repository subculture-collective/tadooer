import { useEffect, useState } from "react";
import type { PluginDataListResponse } from "@suite/contracts";
import {
  deletePluginDataEntry,
  deletePluginMetadata,
  getPluginData,
  getPluginDataContent,
} from "../api.ts";
import {
  confirmPluginDelete,
  deletePrompt,
  entryLabel,
  formatBytes,
  groupPluginData,
  preparePluginDownload,
  type PluginDataApi,
  type PluginDataDeleteTarget,
} from "./plugin-data-controller.ts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/section-heading";
import { useLiveRevision } from "../live-sync/views.ts";

const defaultApi: PluginDataApi = {
  list: getPluginData,
  read: getPluginDataContent,
  deleteEntry: deletePluginDataEntry,
  deletePlugin: deletePluginMetadata,
};

const saveFile = (name: string, text: string) => {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
};

export interface PluginDataViewProps {
  readonly list: PluginDataListResponse | null;
  readonly pending: PluginDataDeleteTarget | null;
  readonly busy: boolean;
  readonly message: string | null;
  readonly error: string | null;
  readonly onDownload: (entryId: string) => void;
  readonly onRequestDelete: (target: PluginDataDeleteTarget) => void;
  readonly onConfirmDelete: () => void;
  readonly onCancelDelete: () => void;
}

/**
 * Lists imported plugin records by plugin: keys, sizes and enabled flags.
 * The opaque data is never shown; it can only be downloaded as a file.
 */
export const PluginDataView = ({
  list,
  pending,
  busy,
  message,
  error,
  onDownload,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
}: PluginDataViewProps) => {
  const groups = list === null ? [] : groupPluginData(list);
  return (
    <section aria-labelledby="plugin-data-title">
      <SectionHeading
        as="h3"
        id="plugin-data-title"
        title="Imported plugin data"
      />
      <p>
        Data and enabled flags that Super Productivity plugins stored, kept
        exactly as exported. Tadooer does not run plugins or read this data.
        Download an entry to keep a copy; deleting it is permanent.
      </p>
      <p className="hint">
        Online only: this list is not cached for offline use.
      </p>
      {message !== null && <p role="status">{message}</p>}
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {pending !== null && (
        <div role="alertdialog" aria-labelledby="plugin-data-confirm">
          <p id="plugin-data-confirm">{deletePrompt(pending)}</p>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={onConfirmDelete}
          >
            Delete permanently
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
      {list === null ? (
        error === null && <p>Loading imported plugin data…</p>
      ) : groups.length === 0 ? (
        <p>No plugin data has been imported.</p>
      ) : (
        <ul className="grid gap-3">
          {groups.map((group) => (
            <li key={group.pluginId}>
              <strong>{group.pluginId}</strong>{" "}
              {group.metadata === null ? (
                <Badge variant="outline">No enabled flag recorded</Badge>
              ) : (
                <Badge variant={group.metadata.enabled ? "success" : "outline"}>
                  {group.metadata.enabled
                    ? "Enabled in Super Productivity"
                    : "Disabled in Super Productivity"}
                </Badge>
              )}{" "}
              <span>
                {group.entries.length} entr
                {group.entries.length === 1 ? "y" : "ies"} ·{" "}
                {formatBytes(group.totalBytes)}
              </span>
              {group.metadata !== null && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`Delete enabled flag for ${group.pluginId}`}
                  onClick={() => {
                    if (group.metadata !== null)
                      onRequestDelete({
                        kind: "plugin",
                        plugin: group.metadata,
                      });
                  }}
                >
                  Delete flag
                </Button>
              )}
              {group.entries.length > 0 && (
                <ul>
                  {group.entries.map((entry) => (
                    <li key={entry.id}>
                      <span>{entryLabel(entry)}</span> ·{" "}
                      <span>{formatBytes(entry.byteLength)}</span>
                      {entry.format === "gzip_base64" && (
                        <span> · compressed</span>
                      )}{" "}
                      <Button
                        type="button"
                        variant="outline"
                        disabled={busy}
                        aria-label={`Download ${group.pluginId} ${entryLabel(entry).toLowerCase()}`}
                        onClick={() => onDownload(entry.id)}
                      >
                        Download
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={busy}
                        aria-label={`Delete ${group.pluginId} ${entryLabel(entry).toLowerCase()}`}
                        onClick={() =>
                          onRequestDelete({ kind: "entry", entry })
                        }
                      >
                        Delete
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

export const ImportedPluginData = ({
  csrfToken,
  refreshKey = 0,
  api = defaultApi,
}: {
  readonly csrfToken: string;
  /** Changes after an import so the list reloads. */
  readonly refreshKey?: number;
  readonly api?: PluginDataApi;
}) => {
  const [list, setList] = useState<PluginDataListResponse | null>(null);
  const [pending, setPending] = useState<PluginDataDeleteTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const liveRevision = useLiveRevision("pluginData");
  useEffect(() => {
    let current = true;
    api
      .list()
      .then((loaded) => {
        if (current) setList(loaded);
      })
      .catch(() => {
        if (current) setError("Could not load imported plugin data.");
      });
    return () => {
      current = false;
    };
  }, [api, refreshKey, liveRevision]);
  const run = async (work: () => Promise<void>, failure: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await work();
    } catch {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  return (
    <PluginDataView
      list={list}
      pending={pending}
      busy={busy}
      message={message}
      error={error}
      onDownload={(entryId) => {
        const entry = list?.entries.find(({ id }) => id === entryId);
        if (entry === undefined) return;
        void run(async () => {
          const file = await preparePluginDownload(api, entry);
          saveFile(file.fileName, file.text);
          setMessage(`Downloaded ${file.fileName}.`);
        }, "Could not download that entry. Reload and try again.");
      }}
      onRequestDelete={setPending}
      onCancelDelete={() => setPending(null)}
      onConfirmDelete={() => {
        if (pending === null) return;
        void run(async () => {
          setList(await confirmPluginDelete(api, pending, csrfToken));
          setPending(null);
          setMessage("Deleted.");
        }, "Could not delete. It may have changed; reload and try again.");
      }}
    />
  );
};
