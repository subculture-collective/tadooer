import { describe, expect, it } from "vitest";
import { pluginDataLimits } from "@suite/contracts";
import { prepareSuperProductivityImport } from "./super-productivity-apply.ts";

// Plugin sections (issue #66, ADR 0026).
const task = { ids: ["t"], entities: { t: { id: "t", title: "Task" } } };
const prepare = (sections: Record<string, unknown>) =>
  prepareSuperProductivityImport(JSON.stringify({ task, ...sections }));
const secret = "SECRET-PLUGIN-CONTENT";

describe("Super Productivity plugin sections", () => {
  it("keeps plugin data opaque and metadata inert without blocking", () => {
    const result = prepare({
      pluginUserData: [
        { id: "brain-dump", data: `{"note":"${secret}"}` },
        { id: "doc-mode:doc:1234", data: `GZ1:${secret}` },
      ],
      pluginMetadata: [
        { id: "brain-dump", isEnabled: true },
        { id: "github-issue-provider", isEnabled: false },
      ],
    });
    expect(result.report.canApply).toBe(true);
    expect(result.plugins).toEqual({
      entries: [
        {
          sourceId: "brain-dump",
          pluginId: "brain-dump",
          key: null,
          data: `{"note":"${secret}"}`,
        },
        {
          sourceId: "doc-mode:doc:1234",
          pluginId: "doc-mode",
          // Split at the first colon, as the source does.
          key: "doc:1234",
          data: `GZ1:${secret}`,
        },
      ],
      plugins: [
        { pluginId: "brain-dump", enabled: true },
        { pluginId: "github-issue-provider", enabled: false },
      ],
    });
    const preserved = result.report.issues.find(
      ({ code }) => code === "plugin_data_preserved",
    );
    expect(preserved).toMatchObject({ blocking: false, sourceId: null });
    expect(preserved?.detail).toContain("2 plugin data entries (");
    expect(preserved?.detail).toContain("from 3 plugins");
    expect(JSON.stringify(result.report)).not.toContain(secret);
    expect(JSON.stringify(result.records)).not.toContain(secret);
  });

  it("preserves odd strings code unit for code unit", () => {
    // A lone surrogate, NUL, a line separator and markup survive JSON
    // transport and are never interpreted.
    const odd = "\ud800 \u0000 \u2028 <script>alert(1)</script> \udfff";
    const raw = JSON.stringify({
      task,
      pluginUserData: [
        { id: "odd", data: odd },
        { id: "empty", data: "" },
      ],
    });
    expect(raw).toContain("\\ud800");
    const result = prepareSuperProductivityImport(raw);
    expect(result.report.canApply).toBe(true);
    expect(result.plugins.entries.map(({ data }) => data)).toEqual([odd, ""]);
  });

  it("accepts the size bound exactly and blocks one byte more", () => {
    const limit = "a".repeat(pluginDataLimits.dataBytes);
    expect(
      prepare({ pluginUserData: [{ id: "p", data: limit }] }).report,
    ).toMatchObject({ canApply: true });
    // Multi-byte text is measured in UTF-8 bytes.
    const over = `${"a".repeat(pluginDataLimits.dataBytes - 1)}é`;
    const report = prepare({
      pluginUserData: [{ id: "p", data: over }],
    }).report;
    expect(report.canApply).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "plugin_data_invalid",
        sourceId: "p",
        blocking: true,
      }),
    );
  });

  it("blocks malformed entries with content-safe findings", () => {
    const longKey = `k${"x".repeat(pluginDataLimits.keyLength)}`;
    const cases: Record<string, unknown>[] = [
      { pluginUserData: { p: secret } },
      { pluginUserData: [secret] },
      { pluginUserData: [{ data: secret }] },
      { pluginUserData: [{ id: `p:${longKey}`, data: secret }] },
      { pluginUserData: [{ id: "p:", data: secret }] },
      { pluginUserData: [{ id: ":key", data: secret }] },
      { pluginUserData: [{ id: "p\u0001", data: secret }] },
      { pluginUserData: [{ id: "p", data: { value: secret } }] },
      { pluginUserData: [{ id: "p", data: secret, extra: secret }] },
      {
        pluginUserData: [
          { id: "p:k", data: secret },
          { id: "p:k", data: secret },
        ],
      },
      { pluginMetadata: [{ id: "p", isEnabled: "yes" }] },
      { pluginMetadata: [{ id: "p:k", isEnabled: true }] },
      { pluginMetadata: [{ id: "p", isEnabled: true, version: "1" }] },
      {
        pluginMetadata: [
          { id: "p", isEnabled: true },
          { id: "p", isEnabled: false },
        ],
      },
      { pluginMetadata: "p" },
    ];
    for (const sections of cases) {
      const report = prepare(sections).report;
      expect(report.canApply, JSON.stringify(sections)).toBe(false);
      expect(report.issues.map(({ code }) => code)).toContain(
        "plugin_data_invalid",
      );
      expect(JSON.stringify(report)).not.toContain(secret);
      expect(JSON.stringify(report)).not.toContain(longKey);
    }
  });

  it("imports an export without plugin sections unchanged", () => {
    const result = prepare({ pluginUserData: [], pluginMetadata: [] });
    expect(result.plugins).toEqual({ entries: [], plugins: [] });
    expect(result.report.issues.map(({ code }) => code)).toEqual([]);
  });
});
