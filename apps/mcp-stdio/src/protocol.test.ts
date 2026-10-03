import { describe, expect, it, vi } from "vitest";
import type { AdapterConfig } from "./config.ts";
import { McpStdioServer, type AutomationCatalog } from "./protocol.ts";

const config: AdapterConfig = {
  baseUrl: new URL("https://suite.example.test/"),
  token: "a".repeat(43),
};

const catalog: AutomationCatalog = {
  tools: [
    {
      name: "task_create_preview",
      description: "Preview one task",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      http: { method: "POST", path: "/api/automation/v1/tasks/preview" },
    },
  ],
  resources: [
    {
      uri: "suite://v1/tasks/open",
      name: "Open tasks",
      description: "Current open tasks",
      mimeType: "application/json",
      http: { path: "/api/automation/v1/resources/tasks/open" },
    },
  ],
};

describe("MCP stdio protocol", () => {
  it("advertises catalog-derived tools and resources", async () => {
    const server = new McpStdioServer(catalog, config, "test");
    await expect(
      server.handle({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    ).resolves.toMatchObject({
      result: {
        serverInfo: {
          name: "productivity-suite",
          title: "Tadooer",
          version: "test",
        },
      },
    });
    await expect(
      server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    ).resolves.toMatchObject({
      result: {
        tools: [
          { name: "task_create_preview", inputSchema: { type: "object" } },
        ],
      },
    });
    await expect(
      server.handle({ jsonrpc: "2.0", id: 3, method: "resources/list" }),
    ).resolves.toMatchObject({
      result: { resources: [{ uri: "suite://v1/tasks/open" }] },
    });
  });

  it("calls only catalog paths with a bearer token and returns structured content", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ previewId: "preview-1" }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      const server = new McpStdioServer(catalog, config);
      await expect(
        server.handle({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "task_create_preview",
            arguments: { title: "Safe task" },
          },
        }),
      ).resolves.toMatchObject({
        result: {
          isError: false,
          structuredContent: { previewId: "preview-1" },
        },
      });
      const request = fetcher.mock.calls.at(0);
      expect(request?.[0]).toEqual(
        "https://suite.example.test/api/automation/v1/tasks/preview",
      );
      expect(request?.[1]?.method).toBe("POST");
      expect(new Headers(request?.[1]?.headers).get("authorization")).toBe(
        `Bearer ${config.token}`,
      );
      expect(request?.[1]?.body).toBe(JSON.stringify({ title: "Safe task" }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("serializes validated Boolean GET resource arguments as query parameters", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ templates: [] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetcher);
    try {
      const resourceCatalog: AutomationCatalog = {
        tools: [],
        resources: [
          {
            uri: "suite://v1/templates",
            name: "Templates",
            description: "Inert task templates",
            mimeType: "application/json",
            http: { path: "/api/automation/v1/resources/templates" },
            inputValidator: {
              safeParse: () => ({
                success: true as const,
                data: { query: "", includeArchived: false },
              }),
            },
          },
        ],
      };
      const server = new McpStdioServer(resourceCatalog, config);
      await expect(
        server.handle({
          jsonrpc: "2.0",
          id: 4,
          method: "resources/read",
          params: { uri: "suite://v1/templates" },
        }),
      ).resolves.toMatchObject({
        result: { contents: [{ uri: "suite://v1/templates" }] },
      });
      const destination = fetcher.mock.calls.at(0)?.[0];
      expect(destination).toEqual(
        "https://suite.example.test/api/automation/v1/resources/templates?query=&includeArchived=false",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns safe MCP errors without network detail or credentials", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        new Error("https://secret.example.test/token=super-secret"),
      );
    vi.stubGlobal("fetch", fetcher);
    try {
      const server = new McpStdioServer(catalog, config);
      const result = await server.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "task_create_preview", arguments: {} },
      });
      expect(JSON.stringify(result)).toContain(
        "AUTOMATION_TRANSPORT_UNAVAILABLE",
      );
      expect(JSON.stringify(result)).not.toContain("secret.example");
      expect(JSON.stringify(result)).not.toContain(config.token);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not reply to protocol notifications", async () => {
    const server = new McpStdioServer(catalog, config);
    await expect(
      server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).resolves.toBeUndefined();
  });
});
