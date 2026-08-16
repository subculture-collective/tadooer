import { automationCatalog } from "@suite/contracts";
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

// The shared contract catalog is the sole declaration of Suite automation
// surface. This adapter only turns its Zod contracts into MCP-facing schemas.
export const loadMcpCatalog = (): AutomationCatalog => {
  const tools = automationCatalog
    .filter((entry) => entry.kind === "tool")
    .map((entry) => ({
      name: entry.mcpName,
      description: entry.id,
      inputSchema: z.toJSONSchema(entry.inputSchema),
      outputSchema: z.toJSONSchema(entry.outputSchema),
      http: { method: "POST" as const, path: entry.apiPath },
      inputValidator: entry.inputSchema,
      outputValidator: entry.outputSchema,
    }));
  const resources = automationCatalog
    .filter((entry) => entry.kind === "resource")
    .map((entry) => ({
      uri: entry.mcpUri,
      name: entry.mcpName,
      description: entry.id,
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
