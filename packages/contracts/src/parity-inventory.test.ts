import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";

const inventory = z
  .object({
    version: z.literal(1),
    source: z.object({
      commit: z.string().regex(/^[a-f0-9]{40}$/),
      installedAsarSha256: z.string().regex(/^[a-f0-9]{64}$/),
      installedCommitVerified: z.literal(false),
    }),
    sourceFeatureDirectories: z.array(z.string()),
    exportSections: z.array(z.string()),
    rows: z.array(
      z.object({
        id: z.string(),
        sourceFeatures: z.array(z.string()),
        exportSections: z.array(z.string()),
        issue: z.number().int().positive(),
        status: z.enum(["partial", "missing", "decision-gated"]),
        mapping: z.string().min(1),
        acceptance: z.string().min(1),
        offlineSync: z.string().min(1),
        assistantIssue: z.number().int().positive(),
      }),
    ),
    mcpActions: z.array(
      z.object({ action: z.string(), tool: z.string(), row: z.string() }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          "../../../docs/product/super-productivity-parity.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );

it("accounts for every captured source feature, export section and MCP tool", () => {
  const rows = new Set(inventory.rows.map((r) => r.id));
  expect(rows.size).toBe(inventory.rows.length);
  expect(new Set(inventory.rows.flatMap((r) => r.sourceFeatures))).toEqual(
    new Set(inventory.sourceFeatureDirectories),
  );
  expect(new Set(inventory.rows.flatMap((r) => r.exportSections))).toEqual(
    new Set(inventory.exportSections),
  );
  expect(new Set(inventory.mcpActions.map((r) => r.tool)).size).toBe(
    inventory.mcpActions.length,
  );
  for (const tool of inventory.mcpActions)
    expect(rows.has(tool.row), tool.action).toBe(true);
});
