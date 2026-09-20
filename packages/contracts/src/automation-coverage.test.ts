import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import { z } from "zod";
import { automationCatalog } from "./index.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const inventory = z
  .object({
    version: z.literal(1),
    rows: z.array(
      z.object({
        id: z.string().min(1),
        action: z.string().min(1),
        webApi: z.array(z.string()),
        catalog: z.array(z.string()),
        status: z.enum([
          "covered",
          "partial",
          "gap",
          "owner-only",
          "internal",
          "future",
        ]),
        issue: z.number().int().positive(),
        authority: z.string().min(1),
        source: z.string().min(1),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(
        join(root, "docs/product/assistant-capabilities.json"),
        "utf8",
      ),
    ),
  );

it("requires a reviewed capability disposition for every browser API export", () => {
  const source = ts.createSourceFile(
    "api.ts",
    readFileSync(join(root, "apps/web/src/api.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const exported: string[] = [];
  for (const node of source.statements) {
    if (
      !ts.canHaveModifiers(node) ||
      !ts
        .getModifiers(node)
        ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    )
      continue;
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        expect(ts.isIdentifier(d.name)).toBe(true);
        exported.push(d.name.getText(source));
      }
    } else if (ts.isFunctionDeclaration(node) && node.name !== undefined)
      exported.push(node.name.text);
    else if (ts.isExportDeclaration(node))
      throw new Error("Classify re-exported browser API functions explicitly");
  }
  const mapped = inventory.rows.flatMap((row) => row.webApi);
  expect(new Set(mapped).size).toBe(mapped.length);
  expect(mapped.toSorted()).toEqual(exported.toSorted());
});

it("keeps catalog coverage, source evidence and gap tracking complete", () => {
  const catalogIds = automationCatalog.map((entry) => entry.id);
  const mapped = inventory.rows.flatMap((row) => row.catalog);
  expect(new Set(mapped).size).toBe(mapped.length);
  expect(mapped.toSorted()).toEqual(catalogIds.toSorted());
  expect(new Set(inventory.rows.map((row) => row.id)).size).toBe(
    inventory.rows.length,
  );
  for (const row of inventory.rows) {
    expect(existsSync(join(root, row.source)), row.source).toBe(true);
    if (row.status === "covered" || row.status === "partial")
      expect(row.catalog.length).toBeGreaterThan(0);
    if (["gap", "owner-only", "future"].includes(row.status))
      expect(row.catalog).toEqual([]);
  }
});
