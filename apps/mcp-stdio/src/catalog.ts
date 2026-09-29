import {
  automationApprovalExpiryMinutes,
  automationBatchBounds,
  automationCatalog,
  type AutomationCatalogEntry,
} from "@suite/contracts";
import { z } from "zod";
import {
  type AutomationCatalog,
  type CatalogResource,
  type CatalogTool,
} from "./protocol.ts";

const isTool = (value: unknown): value is CatalogTool => {
  if (typeof value !== "object" || value === null) return false;
  const tool = value as Partial<CatalogTool>;
  return (
    typeof tool.name === "string" &&
    typeof tool.description === "string" &&
    typeof tool.inputSchema === "object" &&
    typeof tool.http === "object"
  );
};

const isResource = (value: unknown): value is CatalogResource => {
  if (typeof value !== "object" || value === null) return false;
  const resource = value as Partial<CatalogResource>;
  return (
    typeof resource.uri === "string" &&
    typeof resource.name === "string" &&
    typeof resource.description === "string" &&
    typeof resource.mimeType === "string" &&
    typeof resource.http === "object"
  );
};

const categoryText = (category: string): string =>
  category.replaceAll("_", " ");

// ADR 0035: the tool description states the declared confirmation rule so an
// assistant reads the policy from the live catalog rather than from prose.
export const describeCatalogEntry = (entry: AutomationCatalogEntry): string => {
  const rule = entry.confirmation;
  if (entry.kind === "resource") return `${entry.id}: read-only.`;
  if (entry.id === "automation.confirm")
    return `${entry.id}: apply a previewed command with a unique idempotency key; the preview expires ${String(automationApprovalExpiryMinutes)} minutes after it was issued.`;
  const consequential = (category: string) =>
    `consequential (${categoryText(category)}): preview, show the user the summary and affected records, and call suite.confirm only after their explicit approval; a refusal leaves the preview to expire with no effect.`;
  const ordinary =
    "ordinary edit: an explicit user request authorizes it; preview then suite.confirm without a second prompt, or pass execute.idempotencyKey to apply it in the preview call when the token policy is execute_ordinary.";
  const bounds =
    entry.id === "tasks.create_many"
      ? ` At most ${String(automationBatchBounds.createManyTasks)} tasks per call.`
      : "";
  switch (rule.kind) {
    case "ordinary":
      return `${entry.id}: ${ordinary}${bounds}`;
    case "consequential":
      return `${entry.id}: ${consequential(rule.category)}${bounds}`;
    case "by_action": {
      const actions = Object.entries(rule.consequential)
        .map(([action, category]) => `${action} (${categoryText(category)})`)
        .join(", ");
      return `${entry.id}: ${ordinary} Except ${actions}: ${consequential("see action")}`;
    }
    case "none":
      return `${entry.id}: no confirmation.`;
  }
};

// The shared contract catalog is the sole declaration of Suite automation
// surface. This adapter only turns its Zod contracts into MCP-facing schemas.
export const loadMcpCatalog = (): AutomationCatalog => {
  const tools = automationCatalog.map((entry) => ({
    name: entry.mcpName,
    description: describeCatalogEntry(entry),
    inputSchema: z.toJSONSchema(entry.inputSchema),
    outputSchema: z.toJSONSchema(entry.outputSchema),
    http: {
      method: entry.kind === "resource" ? ("GET" as const) : ("POST" as const),
      path: entry.apiPath,
    },
    inputValidator: entry.inputSchema,
    outputValidator: entry.outputSchema,
  }));
  const resources = automationCatalog
    .filter((entry) => entry.kind === "resource")
    .map((entry) => ({
      uri: entry.mcpUri,
      name: entry.mcpName,
      description: describeCatalogEntry(entry),
      mimeType: "application/json",
      http: { path: entry.apiPath },
      inputValidator: entry.inputSchema,
      outputValidator: entry.outputSchema,
    }));
  if (!tools.every(isTool) || !resources.every(isResource)) {
    throw new Error("Suite automation catalog is invalid");
  }
  return { tools, resources };
};
