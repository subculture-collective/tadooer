import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { createAutomationClient, ApiRequestError } from "@suite/contracts";
import { z } from "zod";
import { automationApiUrl, type AdapterConfig } from "./config.ts";

const jsonRpcVersion = "2.0";
const maxMessageBytes = 1024 * 1024;

export interface CatalogTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly http: {
    readonly method: "GET" | "POST";
    readonly path: string;
  };
  readonly inputValidator?: CatalogValidator;
  readonly outputValidator?: CatalogValidator;
}

export interface CatalogValidator {
  safeParse(
    input: unknown,
  ):
    | { readonly success: true; readonly data: unknown }
    | { readonly success: false };
}

export interface CatalogResource {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
  readonly http: {
    readonly path: string;
  };
  readonly inputValidator?: CatalogValidator;
  readonly outputValidator?: CatalogValidator;
}

export interface AutomationCatalog {
  readonly tools: readonly CatalogTool[];
  readonly resources: readonly CatalogResource[];
}

interface RpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

interface ToolCallParameters {
  readonly name?: unknown;
  readonly arguments?: unknown;
}

interface ResourceReadParameters {
  readonly uri?: unknown;
}

interface AutomationApiFailure {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly requestId?: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textContent = (
  value: unknown,
): { readonly type: "text"; readonly text: string } => ({
  type: "text",
  text: JSON.stringify(value),
});

const safeFailure = (
  value: unknown,
): {
  readonly code: string;
  readonly message: string;
  readonly requestId?: string;
} => {
  if (!isObject(value)) {
    return {
      code: "AUTOMATION_REQUEST_FAILED",
      message: "Suite automation request failed",
    };
  }
  const failure = value as AutomationApiFailure;
  if (typeof failure.code !== "string" || typeof failure.message !== "string") {
    return {
      code: "AUTOMATION_REQUEST_FAILED",
      message: "Suite automation request failed",
    };
  }
  return typeof failure.requestId === "string"
    ? {
        code: failure.code,
        message: failure.message,
        requestId: failure.requestId,
      }
    : { code: failure.code, message: failure.message };
};

const passthroughSchema = z.unknown();

class AutomationApiClient {
  constructor(private readonly config: AdapterConfig) {}

  async call(
    http: { readonly method: "GET" | "POST"; readonly path: string },
    arguments_: Record<string, unknown>,
  ): Promise<
    | { readonly ok: true; readonly body: unknown }
    | { readonly ok: false; readonly failure: ReturnType<typeof safeFailure> }
  > {
    const { path, body } = resolveHttpPath(http.path, arguments_);
    const destination = automationApiUrl(this.config.baseUrl, path);

    const client = createAutomationClient(
      `${destination.origin}${destination.pathname}`.replace(/\/$/, ""),
    );
    const kind =
      http.method === "GET" ? ("resource" as const) : ("tool" as const);
    const entry = {
      kind,
      apiPath: "",
      inputSchema: passthroughSchema,
      outputSchema: passthroughSchema,
    };

    let effectiveInput: unknown = body;

    if (kind === "resource") {
      const searchParams: Record<string, string> = {};
      for (const [key, value] of Object.entries(body)) {
        if (
          typeof value !== "string" &&
          typeof value !== "number" &&
          typeof value !== "boolean"
        ) {
          return {
            ok: false,
            failure: {
              code: "INVALID_TOOL_ARGUMENTS",
              message: "Suite automation arguments are invalid",
            },
          };
        }
        searchParams[key] = String(value);
      }
      const query = new URLSearchParams(searchParams).toString();
      effectiveInput = searchParams;
      if (query) {
        const base = `${destination.origin}${destination.pathname}`;
        return this.callWithQuery(base, query);
      }
    }

    try {
      const result = await client.request(entry, effectiveInput, {
        headers: { Authorization: `Bearer ${this.config.token}` },
      });
      return { ok: true as const, body: result };
    } catch (error) {
      if (error instanceof ApiRequestError) {
        const failure = safeFailure({
          code: error.code,
          message: error.message,
          requestId: error.requestId,
        });
        return { ok: false as const, failure };
      }
      return {
        ok: false as const,
        failure: {
          code: "AUTOMATION_TRANSPORT_UNAVAILABLE",
          message: "Suite automation transport is unavailable",
        },
      };
    }
  }

  private async callWithQuery(
    base: string,
    query: string,
  ): Promise<
    | { readonly ok: true; readonly body: unknown }
    | { readonly ok: false; readonly failure: ReturnType<typeof safeFailure> }
  > {
    // For GET with query params, fall through to direct fetch since the
    // shared client uses URLSearchParams construction from the input object
    // and we've already done that work.
    const url = `${base}?${query}`;
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.config.token}`,
        },
        redirect: "error" as RequestRedirect,
      });
      const body = (await response.json()) as unknown;
      return response.ok
        ? { ok: true as const, body }
        : { ok: false as const, failure: safeFailure(body) };
    } catch {
      return {
        ok: false as const,
        failure: {
          code: "AUTOMATION_TRANSPORT_UNAVAILABLE",
          message: "Suite automation transport is unavailable",
        },
      };
    }
  }
}

const resolveHttpPath = (
  template: string,
  arguments_: Record<string, unknown>,
): { readonly path: string; readonly body: Record<string, unknown> } => {
  const used = new Set<string>();
  const path = template.replace(
    /\{([A-Za-z][A-Za-z0-9_]*)\}/g,
    (_match, key: string) => {
      const value = arguments_[key];
      if (typeof value !== "string" || value === "")
        throw new Error("invalid automation path parameter");
      used.add(key);
      return encodeURIComponent(value);
    },
  );
  const body = Object.fromEntries(
    Object.entries(arguments_).filter(([key]) => !used.has(key)),
  );
  return { path, body };
};

const validToolCallParameters = (
  value: unknown,
): value is {
  readonly name: string;
  readonly arguments?: Record<string, unknown>;
} => {
  if (!isObject(value)) return false;
  const parameters = value as ToolCallParameters;
  return (
    typeof parameters.name === "string" &&
    (parameters.arguments === undefined || isObject(parameters.arguments))
  );
};

const validResourceReadParameters = (
  value: unknown,
): value is { readonly uri: string } =>
  isObject(value) && typeof (value as ResourceReadParameters).uri === "string";

const toolList = (
  catalog: AutomationCatalog,
): readonly Record<string, unknown>[] =>
  catalog.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: tool.outputSchema }),
  }));

const resourceList = (
  catalog: AutomationCatalog,
): readonly Record<string, unknown>[] =>
  catalog.resources.map((resource) => ({
    uri: resource.uri,
    name: resource.name,
    description: resource.description,
    mimeType: resource.mimeType,
  }));

const resourceTemplateList = (
  catalog: AutomationCatalog,
): readonly Record<string, unknown>[] =>
  catalog.resources
    .filter((resource) => resource.uri.includes("{?"))
    .map((resource) => ({
      uriTemplate: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType,
    }));

const response = (id: unknown, result: unknown): Record<string, unknown> => ({
  jsonrpc: jsonRpcVersion,
  id,
  result,
});

const errorResponse = (
  id: unknown,
  code: number,
  message: string,
): Record<string, unknown> => ({
  jsonrpc: jsonRpcVersion,
  id,
  error: { code, message },
});

export class McpStdioServer {
  private readonly api: AutomationApiClient;
  private readonly tools = new Map<string, CatalogTool>();
  private readonly resources = new Map<string, CatalogResource>();

  constructor(
    private readonly catalog: AutomationCatalog,
    config: AdapterConfig,
    private readonly serverVersion = "0.0.0-dev",
  ) {
    this.api = new AutomationApiClient(config);
    for (const tool of catalog.tools) this.tools.set(tool.name, tool);
    for (const resource of catalog.resources) {
      if (!resource.uri.includes("{?"))
        this.resources.set(resource.uri, resource);
    }
  }

  async handle(message: unknown): Promise<Record<string, unknown> | undefined> {
    if (!isObject(message))
      return errorResponse(null, -32600, "invalid request");
    const request = message as RpcRequest;
    if (
      request.jsonrpc !== jsonRpcVersion ||
      typeof request.method !== "string"
    ) {
      return errorResponse(request.id ?? null, -32600, "invalid request");
    }
    const notification = request.id === undefined;
    const reply = async (): Promise<Record<string, unknown>> => {
      switch (request.method) {
        case "initialize":
          return response(request.id ?? null, {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {}, resources: {} },
            serverInfo: {
              name: "productivity-suite",
              version: this.serverVersion,
            },
          });
        case "tools/list":
          return response(request.id ?? null, {
            tools: toolList(this.catalog),
          });
        case "resources/list":
          return response(request.id ?? null, {
            resources: resourceList(this.catalog).filter(
              (resource) => !String(resource.uri).includes("{?"),
            ),
          });
        case "resources/templates/list":
          return response(request.id ?? null, {
            resourceTemplates: resourceTemplateList(this.catalog),
          });
        case "tools/call":
          return this.handleToolCall(request.id ?? null, request.params);
        case "resources/read":
          return this.handleResourceRead(request.id ?? null, request.params);
        case "notifications/initialized":
          return response(request.id ?? null, {});
        default:
          return errorResponse(request.id ?? null, -32601, "method not found");
      }
    };
    const result = await reply();
    return notification ? undefined : result;
  }

  private async handleToolCall(
    id: unknown,
    params: unknown,
  ): Promise<Record<string, unknown>> {
    if (!validToolCallParameters(params)) {
      return errorResponse(id, -32602, "invalid tool parameters");
    }
    const tool = this.tools.get(params.name);
    if (tool === undefined) {
      return response(id, {
        content: [
          textContent({
            code: "UNKNOWN_TOOL",
            message: "Unknown Suite automation tool",
          }),
        ],
        isError: true,
      });
    }
    const parsed = tool.inputValidator?.safeParse(params.arguments ?? {});
    if (parsed !== undefined && !parsed.success) {
      return response(id, {
        content: [
          textContent({
            code: "INVALID_TOOL_ARGUMENTS",
            message: "Suite automation arguments are invalid",
          }),
        ],
        isError: true,
      });
    }
    const arguments_ = parsed?.success ? parsed.data : (params.arguments ?? {});
    if (!isObject(arguments_)) {
      return response(id, {
        content: [
          textContent({
            code: "INVALID_TOOL_ARGUMENTS",
            message: "Suite automation arguments are invalid",
          }),
        ],
        isError: true,
      });
    }
    const result = await this.api.call(tool.http, arguments_);
    const output = result.ok
      ? tool.outputValidator?.safeParse(result.body)
      : undefined;
    return result.ok
      ? output !== undefined && !output.success
        ? response(id, {
            content: [
              textContent({
                code: "AUTOMATION_INVALID_RESPONSE",
                message: "Suite automation returned an invalid response",
              }),
            ],
            isError: true,
          })
        : response(id, {
            content: [textContent(output?.success ? output.data : result.body)],
            structuredContent: output?.success ? output.data : result.body,
            isError: false,
          })
      : response(id, { content: [textContent(result.failure)], isError: true });
  }

  private async handleResourceRead(
    id: unknown,
    params: unknown,
  ): Promise<Record<string, unknown>> {
    if (!validResourceReadParameters(params)) {
      return errorResponse(id, -32602, "invalid resource parameters");
    }
    const resource =
      this.resources.get(params.uri) ?? this.findResourceTemplate(params.uri);
    if (resource === undefined)
      return errorResponse(id, -32602, "unknown resource");
    const arguments_ = this.resourceArguments(resource, params.uri);
    if (arguments_ === undefined)
      return errorResponse(id, -32602, "invalid resource URI");
    const parsed = resource.inputValidator?.safeParse(arguments_);
    if (parsed !== undefined && !parsed.success)
      return errorResponse(id, -32602, "invalid resource URI");
    let effectiveArguments = arguments_;
    if (parsed?.success) {
      if (!isObject(parsed.data))
        return errorResponse(id, -32602, "invalid resource URI");
      effectiveArguments = parsed.data;
    }
    const result = await this.api.call(
      { method: "GET", path: resource.http.path },
      effectiveArguments,
    );
    const output = result.ok
      ? resource.outputValidator?.safeParse(result.body)
      : undefined;
    return result.ok
      ? output !== undefined && !output.success
        ? response(id, {
            content: [
              textContent({
                code: "AUTOMATION_INVALID_RESPONSE",
                message: "Suite automation returned an invalid response",
              }),
            ],
            isError: true,
          })
        : response(id, {
            contents: [
              {
                uri: params.uri,
                mimeType: resource.mimeType,
                text: JSON.stringify(
                  output?.success ? output.data : result.body,
                ),
              },
            ],
          })
      : response(id, { content: [textContent(result.failure)], isError: true });
  }

  private findResourceTemplate(uri: string): CatalogResource | undefined {
    return this.catalog.resources.find((resource) => {
      const marker = resource.uri.indexOf("{?");
      return marker !== -1 && uri.startsWith(resource.uri.slice(0, marker));
    });
  }

  private resourceArguments(
    resource: CatalogResource,
    uri: string,
  ): Record<string, unknown> | undefined {
    const marker = resource.uri.indexOf("{?");
    if (marker === -1) return uri === resource.uri ? {} : undefined;
    try {
      const parsed = new URL(uri);
      const prefix = resource.uri.slice(0, marker);
      if (`${parsed.protocol}//${parsed.host}${parsed.pathname}` !== prefix)
        return undefined;
      return Object.fromEntries(parsed.searchParams.entries());
    } catch {
      return undefined;
    }
  }

  async serve(input: Readable, output: Writable): Promise<void> {
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      if (Buffer.byteLength(line, "utf8") > maxMessageBytes) {
        output.write(
          `${JSON.stringify(errorResponse(null, -32600, "request too large"))}\n`,
        );
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        output.write(
          `${JSON.stringify(errorResponse(null, -32700, "parse error"))}\n`,
        );
        continue;
      }
      const result = await this.handle(parsed);
      if (result !== undefined) output.write(`${JSON.stringify(result)}\n`);
    }
  }
}
