import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PluginDataListResponse } from "@suite/contracts";
import { PluginDataView } from "./ImportedPluginData.tsx";
import {
  confirmPluginDelete,
  deletePrompt,
  formatBytes,
  groupPluginData,
  preparePluginDownload,
  type PluginDataApi,
} from "./plugin-data-controller.ts";

// Imported plugin data view (issue #66, ADR 0026).
const importedAt = "2026-09-24T12:00:00.000Z";
const list: PluginDataListResponse = {
  plugins: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      pluginId: "sync-md",
      enabled: false,
      source: "super_productivity",
      revision: 1,
      importedAt,
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      pluginId: "brain-dump",
      enabled: true,
      source: "super_productivity",
      revision: 1,
      importedAt,
    },
  ],
  entries: [
    {
      id: "10000000-0000-4000-8000-000000000001",
      pluginId: "brain-dump",
      key: null,
      byteLength: 61,
      format: "text",
      source: "super_productivity",
      revision: 1,
      importedAt,
    },
    {
      id: "10000000-0000-4000-8000-000000000002",
      pluginId: "doc-mode",
      key: "doc:1",
      byteLength: 700 * 1024,
      format: "gzip_base64",
      source: "super_productivity",
      revision: 2,
      importedAt,
    },
  ],
};
const view = (props: Partial<Parameters<typeof PluginDataView>[0]> = {}) =>
  renderToStaticMarkup(
    <PluginDataView
      list={list}
      pending={null}
      busy={false}
      message={null}
      error={null}
      onDownload={vi.fn()}
      onRequestDelete={vi.fn()}
      onConfirmDelete={vi.fn()}
      onCancelDelete={vi.fn()}
      {...props}
    />,
  );

describe("imported plugin data", () => {
  it("groups entries and flags by plugin ID", () => {
    expect(
      groupPluginData(list).map(
        ({ pluginId, metadata, entries, totalBytes }) => ({
          pluginId,
          enabled: metadata?.enabled ?? null,
          entries: entries.length,
          totalBytes,
        }),
      ),
    ).toEqual([
      { pluginId: "brain-dump", enabled: true, entries: 1, totalBytes: 61 },
      {
        pluginId: "doc-mode",
        enabled: null,
        entries: 1,
        totalBytes: 700 * 1024,
      },
      { pluginId: "sync-md", enabled: false, entries: 0, totalBytes: 0 },
    ]);
    expect(formatBytes(61)).toBe("61 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(1024 * 1024)).toBe("1 MiB");
  });

  it("lists plugin IDs, keys, sizes and flags with download and delete", () => {
    const markup = view();
    for (const text of [
      "Imported plugin data",
      "brain-dump",
      "Enabled in Super Productivity",
      "Disabled in Super Productivity",
      "No enabled flag recorded",
      "Key doc:1",
      "Default entry",
      "61 B",
      "700 KiB",
      "compressed",
      "Download",
      "Online only",
    ])
      expect(markup).toContain(text);
    expect(markup).not.toContain("alertdialog");
    expect(view({ list: { plugins: [], entries: [] } })).toContain(
      "No plugin data has been imported.",
    );
  });

  it("asks for confirmation before a permanent delete", () => {
    const entry = list.entries[0];
    if (entry === undefined) throw new Error("entry");
    const markup = view({ pending: { kind: "entry", entry } });
    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain("Permanently delete brain-dump default entry");
    expect(markup).toContain("Delete permanently");
    const plugin = list.plugins[0];
    if (plugin === undefined) throw new Error("plugin");
    expect(deletePrompt({ kind: "plugin", plugin })).toContain(
      "Its data entries are kept",
    );
  });

  it("downloads the exact source entry and deletes with the current revision", async () => {
    const odd = "\ud800 <b>raw</b> \u0000";
    const entry = list.entries[1];
    if (entry === undefined) throw new Error("entry");
    const api: PluginDataApi = {
      list: vi.fn(() => Promise.resolve({ plugins: [], entries: [] })),
      read: vi.fn(() => Promise.resolve({ entry, data: odd })),
      deleteEntry: vi.fn(() => Promise.resolve()),
      deletePlugin: vi.fn(() => Promise.resolve()),
    };
    const file = await preparePluginDownload(api, entry);
    expect(file.fileName).toBe("plugin-data-doc-mode-doc_1.json");
    expect(JSON.parse(file.text)).toEqual({ id: "doc-mode:doc:1", data: odd });
    await expect(
      confirmPluginDelete(api, { kind: "entry", entry }, "csrf"),
    ).resolves.toEqual({ plugins: [], entries: [] });
    expect(api.deleteEntry).toHaveBeenCalledWith(entry.id, 2, "csrf");
    expect(api.deletePlugin).not.toHaveBeenCalled();
  });
});
