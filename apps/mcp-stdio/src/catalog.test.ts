import { describe, expect, it } from "vitest";
import { automationCatalog } from "@suite/contracts";
import { describeCatalogEntry, loadMcpCatalog } from "./catalog.ts";

describe("shared automation catalog mapping", () => {
  it("exposes every shared tool and read-only resource without a second declaration", () => {
    const catalog = loadMcpCatalog();
    expect(catalog.tools.map((tool) => tool.name)).toEqual(
      automationCatalog.map((entry) => entry.mcpName),
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
    expect(
      catalog.tools.find((tool) => tool.name === "suite.tasks.list")?.http,
    ).toEqual({ method: "GET", path: "/api/automation/v1/resources/tasks" });
    const taskCreateSchema = JSON.stringify(
      catalog.tools.find((tool) => tool.name === "suite.tasks.create")
        ?.inputSchema,
    );
    expect(taskCreateSchema).toContain("tasks.create");
    expect(taskCreateSchema).not.toContain("focus.start");
    expect(taskCreateSchema).not.toContain("schedule.create_time_block");

    expect(catalog.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "suite.templates.list",
          uri: "suite://v1/templates",
          http: {
            path: "/api/automation/v1/resources/templates",
          },
        }),
        expect.objectContaining({
          name: "suite.template_sets.list",
          uri: "suite://v1/template-sets",
          http: {
            path: "/api/automation/v1/resources/template-sets",
          },
        }),
      ]),
    );
    const templateInstantiateSchema = JSON.stringify(
      catalog.tools.find((tool) => tool.name === "suite.templates.instantiate")
        ?.inputSchema,
    );
    expect(templateInstantiateSchema).toContain("templates.instantiate");
    expect(templateInstantiateSchema).toContain("templateId");
    expect(templateInstantiateSchema).toContain("destinationProjectId");
    expect(templateInstantiateSchema).not.toContain("tasks.create");
    const setInstantiateSchema = JSON.stringify(
      catalog.tools.find(
        (tool) => tool.name === "suite.template_sets.instantiate",
      )?.inputSchema,
    );
    expect(setInstantiateSchema).toContain("template_sets.instantiate");
    expect(setInstantiateSchema).toContain("setId");
    expect(setInstantiateSchema).not.toContain("templates.instantiate");
  });

  it("states the ADR 0035 confirmation rule in every tool description", () => {
    const catalog = loadMcpCatalog();
    const description = (name: string) =>
      catalog.tools.find((tool) => tool.name === name)?.description ?? "";
    expect(description("suite.tasks.update")).toContain("ordinary edit");
    expect(description("suite.tasks.update")).toContain(
      "execute.idempotencyKey",
    );
    expect(description("suite.tasks.delete")).toContain(
      "consequential (deletion)",
    );
    expect(description("suite.tasks.delete")).not.toContain("execute.");
    expect(description("suite.tasks.create_many")).toContain(
      "At most 100 tasks",
    );
    expect(description("suite.subtasks.mutate")).toContain(
      "Except delete (deletion)",
    );
    expect(description("suite.recurrence.set_state")).toContain(
      "end (irreversible)",
    );
    expect(description("suite.tasks.list")).toBe("tasks.list: read-only.");
    expect(description("suite.confirm")).toContain("5 minutes");
    expect(
      catalog.resources.find((r) => r.name === "suite.tasks.list")?.description,
    ).toBe("tasks.list: read-only.");
    for (const entry of automationCatalog)
      expect(describeCatalogEntry(entry).startsWith(`${entry.id}:`)).toBe(true);
  });
});
