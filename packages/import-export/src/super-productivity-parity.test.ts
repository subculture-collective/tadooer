import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  superProductivityNoteFields,
  superProductivityProjectFields,
  superProductivitySections,
  superProductivityTagFields,
  superProductivityTaskFields,
} from "./super-productivity-schema.ts";
import { superProductivityAttachmentFields } from "./super-productivity-links.ts";
import { superProductivityRepeatCfgFields } from "./super-productivity-recurrence.ts";
import {
  superProductivityMetricFields,
  superProductivitySimpleCounterFields,
} from "./super-productivity-counters.ts";
import {
  superProductivityPluginMetadataFields,
  superProductivityPluginUserDataFields,
} from "./super-productivity-plugins.ts";
import { superProductivityPlannerKeys } from "./super-productivity-day-order.ts";
import {
  superProductivityBoardFields,
  superProductivityBoardPanelFields,
  superProductivityMenuFolderFields,
  superProductivityMenuTreeFields,
  superProductivitySectionFields,
} from "./super-productivity-boards.ts";
import { superProductivityFocusConfigFields } from "./super-productivity-focus.ts";
import { superProductivityGlobalConfigFields } from "./super-productivity-config.ts";

type FieldKey =
  | "taskFields"
  | "projectFields"
  | "tagFields"
  | "noteFields"
  | "attachmentFields"
  | "repeatCfgFields"
  | "simpleCounterFields"
  | "metricFields"
  | "pluginUserDataFields"
  | "pluginMetadataFields"
  | "plannerFields"
  | "boardFields"
  | "boardPanelFields"
  | "sectionFields"
  | "menuTreeFields"
  | "menuFolderFields"
  | "focusConfigFields"
  | "globalConfigFields";
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
  rows: ({ id: string } & Partial<Record<FieldKey, string[]>>)[];
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
    ["noteFields", superProductivityNoteFields],
    ["attachmentFields", superProductivityAttachmentFields],
    ["repeatCfgFields", superProductivityRepeatCfgFields],
    ["simpleCounterFields", superProductivitySimpleCounterFields],
    ["metricFields", superProductivityMetricFields],
    ["pluginUserDataFields", superProductivityPluginUserDataFields],
    ["pluginMetadataFields", superProductivityPluginMetadataFields],
    ["plannerFields", superProductivityPlannerKeys],
    ["boardFields", superProductivityBoardFields],
    ["boardPanelFields", superProductivityBoardPanelFields],
    ["sectionFields", superProductivitySectionFields],
    ["menuTreeFields", superProductivityMenuTreeFields],
    ["menuFolderFields", superProductivityMenuFolderFields],
    ["focusConfigFields", superProductivityFocusConfigFields],
    ["globalConfigFields", superProductivityGlobalConfigFields],
  ] as const) {
    const mapped = manifest.rows.flatMap((row) => row[key] ?? []);
    expect(new Set(mapped).size, key).toBe(mapped.length);
    expect(mapped.toSorted(), key).toEqual(Object.keys(table).toSorted());
  }
});
