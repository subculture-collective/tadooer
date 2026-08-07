import { describe, expect, it } from "vitest";
import { automationCatalog } from "@suite/contracts";
import { loadMcpCatalog } from "./catalog.ts";

describe("shared automation catalog mapping", () => {
  it("exposes every shared tool and read-only resource without a second declaration", () => {
    const catalog = loadMcpCatalog();
    expect(catalog.tools.map((tool) => tool.name)).toEqual(
      automationCatalog
        .filter((entry) => entry.kind === "tool")
        .map((entry) => entry.mcpName),
    );
    expect(catalog.resources.map((resource) => resource.uri)).toEqual(
      automationCatalog
        .filter((entry) => entry.kind === "resource")
        .map((entry) => entry.mcpUri),
    );
    expect(
      catalog.tools.find((tool) => tool.name === "suite.confirm")?.http,
    ).toEqual({
      method: "POST",
      path: "/api/automation/v1/previews/{previewId}/confirm",
    });
    const taskCreateSchema = JSON.stringify(
      catalog.tools.find((tool) => tool.name === "suite.tasks.create")
        ?.inputSchema,
    );
    expect(taskCreateSchema).toContain("tasks.create");
    expect(taskCreateSchema).not.toContain("focus.start");
    expect(taskCreateSchema).not.toContain("schedule.create_time_block");
  });
});
