import { expect, it } from "vitest";
import { superProductivityImportLimits as limits } from "@suite/contracts";
import { previewSuperProductivity } from "./super-productivity.ts";

it("counts UTF-8 bytes at the inclusive import limit without truncating JSON", () => {
  const json = JSON.stringify({ task: { ids: [], entities: {} }, extra: "é" });
  const atLimit = json + " ".repeat(limits.bytes - Buffer.byteLength(json));
  expect(previewSuperProductivity(atLimit.slice(0, -1)).totals.tasks).toBe(0);
  expect(previewSuperProductivity(atLimit).totals.tasks).toBe(0);
  expect(() => previewSuperProductivity(atLimit + " ")).toThrow("16 MiB");
  expect(() => previewSuperProductivity("{")).toThrow();
});

it("bounds indexed and unindexed records across live and archived entity stores", () => {
  const ids = Array.from(
    { length: limits.records },
    (_, i) => `task-${String(i)}`,
  );
  const entities = Object.fromEntries(
    ids.map((id) => [id, { id, title: "Task" }]),
  );
  expect(
    previewSuperProductivity(JSON.stringify({ task: { ids, entities } })).totals
      .tasks,
  ).toBe(limits.records);
  expect(() =>
    previewSuperProductivity(
      JSON.stringify({
        task: { ids, entities },
        archiveOld: {
          task: {
            ids: ["old"],
            entities: { old: { id: "old", title: "Old" } },
          },
        },
      }),
    ),
  ).toThrow("50,000 record");
  expect(() =>
    previewSuperProductivity(
      JSON.stringify({ task: { ids: [...ids, "missing"], entities: {} } }),
    ),
  ).toThrow("50,000 record");
});
