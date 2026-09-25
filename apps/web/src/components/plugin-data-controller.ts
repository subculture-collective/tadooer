import {
  pluginDataDownload,
  type PluginDataContentResponse,
  type PluginDataEntry,
  type PluginDataListResponse,
  type PluginMetadata,
} from "@suite/contracts";

/** Browser API used by the imported plugin data view (ADR 0026). */
export interface PluginDataApi {
  readonly list: () => Promise<PluginDataListResponse>;
  readonly read: (id: string) => Promise<PluginDataContentResponse>;
  readonly deleteEntry: (
    id: string,
    revision: number,
    csrfToken: string,
  ) => Promise<void>;
  readonly deletePlugin: (
    id: string,
    revision: number,
    csrfToken: string,
  ) => Promise<void>;
}

/** One plugin with its metadata record (if imported) and data entries. */
export interface PluginDataGroup {
  readonly pluginId: string;
  readonly metadata: PluginMetadata | null;
  readonly entries: readonly PluginDataEntry[];
  readonly totalBytes: number;
}

/** Target of a pending delete confirmation. */
export type PluginDataDeleteTarget =
  | { readonly kind: "entry"; readonly entry: PluginDataEntry }
  | { readonly kind: "plugin"; readonly plugin: PluginMetadata };

export const groupPluginData = (
  list: PluginDataListResponse,
): readonly PluginDataGroup[] => {
  const ids = [
    ...new Set([
      ...list.plugins.map(({ pluginId }) => pluginId),
      ...list.entries.map(({ pluginId }) => pluginId),
    ]),
  ].toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return ids.map((pluginId) => {
    const entries = list.entries.filter((entry) => entry.pluginId === pluginId);
    return {
      pluginId,
      metadata:
        list.plugins.find((plugin) => plugin.pluginId === pluginId) ?? null,
      entries,
      totalBytes: entries.reduce((sum, entry) => sum + entry.byteLength, 0),
    };
  });
};

export const formatBytes = (bytes: number): string =>
  bytes < 1024
    ? `${bytes.toLocaleString("en-US")} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toLocaleString("en-US", { maximumFractionDigits: 1 })} KiB`
      : `${(bytes / 1024 / 1024).toLocaleString("en-US", { maximumFractionDigits: 2 })} MiB`;

export const entryLabel = (entry: PluginDataEntry): string =>
  entry.key === null ? "Default entry" : `Key ${entry.key}`;

export const deletePrompt = (target: PluginDataDeleteTarget): string =>
  target.kind === "entry"
    ? `Permanently delete ${target.entry.pluginId} ${entryLabel(target.entry).toLowerCase()} (${formatBytes(target.entry.byteLength)})? Download it first if you may need it. Importing the same export again will not restore it.`
    : `Permanently delete the enabled flag recorded for ${target.plugin.pluginId}? Its data entries are kept. Importing the same export again will not restore it.`;

/** Reads one entry and returns the file to save; the data is not shown. */
export const preparePluginDownload = async (
  api: PluginDataApi,
  entry: PluginDataEntry,
): Promise<{ readonly fileName: string; readonly text: string }> => {
  const { entry: current, data } = await api.read(entry.id);
  return pluginDataDownload(current, data);
};

export const confirmPluginDelete = async (
  api: PluginDataApi,
  target: PluginDataDeleteTarget,
  csrfToken: string,
): Promise<PluginDataListResponse> => {
  if (target.kind === "entry")
    await api.deleteEntry(target.entry.id, target.entry.revision, csrfToken);
  else
    await api.deletePlugin(target.plugin.id, target.plugin.revision, csrfToken);
  return api.list();
};
