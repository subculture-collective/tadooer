import { describe, expect, it } from "vitest";
import {
  automationCatalog,
  automationTokenScopeSchema,
  pluginDataDownload,
  pluginDataFormat,
  pluginDataListResponseSchema,
  validPluginId,
} from "./index.ts";

// Imported plugin data contracts (issue #66, ADR 0026).
describe("plugin data contracts", () => {
  it("accepts source plugin IDs and rejects key delimiters and controls", () => {
    for (const id of ["brain-dump", "super-productivity-mcp", "x".repeat(200)])
      expect(validPluginId(id), id).toBe(true);
    for (const id of ["", "a:b", "a\u0000", "a\n", "x".repeat(201)])
      expect(validPluginId(id), JSON.stringify(id)).toBe(false);
  });

  it("detects only the compressed prefix", () => {
    expect(pluginDataFormat("GZ1:H4sI")).toBe("gzip_base64");
    expect(pluginDataFormat("gz1:abc")).toBe("text");
    expect(pluginDataFormat("")).toBe("text");
  });

  it("downloads the source entry shape with every code unit escaped", () => {
    const data = "\ud800 \u0000 end";
    const file = pluginDataDownload(
      { pluginId: "doc-mode", key: "doc/1" },
      data,
    );
    expect(file.fileName).toBe("plugin-data-doc-mode-doc_1.json");
    expect(file.text).toContain("\\ud800");
    expect(JSON.parse(file.text)).toEqual({ id: "doc-mode:doc/1", data });
    expect(
      pluginDataDownload({ pluginId: "../../x", key: null }, "").fileName,
    ).toBe("plugin-data-.._.._x.json");
  });

  it("exposes a read-only listing to the assistant with its own scope", () => {
    expect(automationTokenScopeSchema.options).toContain("plugin_data:read");
    expect(automationTokenScopeSchema.options).not.toContain(
      "plugin_data:write",
    );
    const entry = automationCatalog.find(({ id }) => id === "plugin_data.list");
    expect(entry).toMatchObject({
      kind: "resource",
      scopes: ["plugin_data:read"],
      confirmationRequired: false,
      apiPath: "/api/automation/v1/resources/plugin-data",
    });
    // The listing schema has no field for the data itself.
    expect(
      pluginDataListResponseSchema.safeParse({
        plugins: [],
        entries: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            pluginId: "p",
            key: null,
            byteLength: 2,
            format: "text",
            source: "super_productivity",
            revision: 1,
            importedAt: "2026-09-24T12:00:00.000Z",
            data: "{}",
          },
        ],
      }).success,
    ).toBe(false);
  });
});
