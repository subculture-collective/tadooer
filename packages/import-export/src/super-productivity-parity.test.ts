import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  superProductivityProjectFields,
  superProductivitySections,
  superProductivityTagFields,
  superProductivityTaskFields,
} from "./super-productivity-schema.ts";

type FieldKey = "taskFields" | "projectFields" | "tagFields";
const manifest = JSON.parse(
  readFileSync(
    new URL(
      "../../../docs/product/super-productivity-parity.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  exportSections: string[];
  rows: ({ id: string } & Record<FieldKey, string[]>)[];
};

it("classifies exactly the manifest's export sections for import", () => {
  expect(Object.keys(superProductivitySections).toSorted()).toEqual(
    manifest.exportSections.toSorted(),
  );
});

it("assigns every reviewed entity field to exactly one workflow row", () => {
  for (const [key, table] of [
    ["taskFields", superProductivityTaskFields],
    ["projectFields", superProductivityProjectFields],
    ["tagFields", superProductivityTagFields],
  ] as const) {
    const mapped = manifest.rows.flatMap((row) => row[key]);
    expect(new Set(mapped).size, key).toBe(mapped.length);
    expect(mapped.toSorted(), key).toEqual(Object.keys(table).toSorted());
  }
});
