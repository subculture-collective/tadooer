import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  superProductivityProjectFields,
  superProductivitySections,
  superProductivityTagFields,
  superProductivityTaskFields,
} from "./super-productivity-schema.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
interface ParityRow {
  id: string;
  status: "supported" | "partial" | "gap" | "decision";
  issue: number | null;
  proposedIssue?: string;
  tadooer: string[];
  tests: string[];
  sections: string[];
  taskFields: string[];
  projectFields: string[];
  tagFields: string[];
}
const matrix = JSON.parse(
  readFileSync(
    join(root, "docs/product/super-productivity-parity.json"),
    "utf8",
  ),
) as {
  version: number;
  pins: { exportSchema: { sections: number } };
  rows: ParityRow[];
};

it("assigns every reviewed export section and entity field to exactly one parity row", () => {
  const expectCovered = (
    key: "sections" | "taskFields" | "projectFields" | "tagFields",
    table: Readonly<Record<string, string>>,
  ) => {
    const mapped = matrix.rows.flatMap((row) => row[key]);
    expect(new Set(mapped).size, key).toBe(mapped.length);
    expect(mapped.toSorted(), key).toEqual(Object.keys(table).toSorted());
  };
  expectCovered("sections", superProductivitySections);
  expectCovered("taskFields", superProductivityTaskFields);
  expectCovered("projectFields", superProductivityProjectFields);
  expectCovered("tagFields", superProductivityTagFields);
  expect(Object.keys(superProductivitySections)).toHaveLength(
    matrix.pins.exportSchema.sections,
  );
});

it("keeps row evidence present and tracks every unresolved row", () => {
  expect(matrix.version).toBe(1);
  expect(new Set(matrix.rows.map((row) => row.id)).size).toBe(
    matrix.rows.length,
  );
  for (const row of matrix.rows) {
    for (const path of [...row.tadooer, ...row.tests])
      expect(existsSync(join(root, path)), `${row.id}: ${path}`).toBe(true);
    expect(["supported", "partial", "gap", "decision"]).toContain(row.status);
    if (row.status === "supported")
      expect(row.tests.length, row.id).toBeGreaterThan(0);
    else
      expect(
        row.issue !== null || row.proposedIssue !== undefined,
        `${row.id} needs a tracking issue`,
      ).toBe(true);
    if (row.status === "partial")
      expect(row.tadooer.length, row.id).toBeGreaterThan(0);
  }
});
