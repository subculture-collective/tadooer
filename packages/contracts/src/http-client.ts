import type { z } from "zod";

/**
 * A minimal shape from AutomationCatalogEntry used by the client.
 * Defined inline to avoid a circular import from index.ts.
 */
interface CatalogEntry {
  readonly kind: "resource" | "tool";
  readonly apiPath: string;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
}

/**
 * Shared error for all automation HTTP requests.
 * The optional `requestId` links to the server-side audit log.
 */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

const resolvePath = (
  template: string,
  params?: Record<string, string>,
): string => {
  if (!params) return template;
  return template.replace(
    /\{([A-Za-z][A-Za-z0-9_]*)\}/g,
    (_match, key: string) => {
      const value = params[key];
      if (value === undefined)
        throw new Error(`Missing path parameter: ${key}`);
      return encodeURIComponent(value);
    },
  );
};

const safeCode = (raw: unknown): string =>
  typeof raw === "string" ? raw : "REQUEST_FAILED";

const safeMessage = (raw: unknown): string =>
  typeof raw === "string" ? raw : "Request failed";

const safeRequestId = (raw: unknown): string | undefined =>
  typeof raw === "string" ? raw : undefined;

/**
 * Creates a typed automation HTTP client against the given Suite origin.
 *
 *   const client = createAutomationClient("https://suite.example");
 *   const tasks = await client.request(tasksListEntry, {});
 */
export const createAutomationClient = (baseUrl: string) => {
  const execute = async <T extends CatalogEntry>(
    entry: T,
    input: z.input<T["inputSchema"]>,
    headers: Record<string, string> = {},
    pathParams?: Record<string, string>,
  ): Promise<z.output<T["outputSchema"]>> => {
    entry.inputSchema.parse(input);
    const path = resolvePath(entry.apiPath, pathParams);
    const method = entry.kind === "resource" ? "GET" : "POST";

    let url = `${baseUrl}${path}`;
    let body: string | undefined;

    if (entry.kind === "tool") {
      body = JSON.stringify(input);
    } else {
      const entries = Object.entries(input as Record<string, unknown>);
      if (entries.length > 0) {
        const searchParams = new URLSearchParams();
        for (const [key, value] of entries) {
          searchParams.set(key, String(value));
        }
        url += `?${searchParams.toString()}`;
      }
    }

    const init: RequestInit = {
      method,
      headers: {
        "Content-Type": body !== undefined ? "application/json" : "",
        ...headers,
      },
    };
    if (body !== undefined) init.body = body;

    const response = await fetch(url, init);
    const raw = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    if (!response.ok) {
      throw new ApiRequestError(
        response.status,
        safeCode(raw.code),
        safeMessage(raw.message),
        safeRequestId(raw.requestId),
      );
    }

    return entry.outputSchema.parse(raw) as z.output<T["outputSchema"]>;
  };

  return {
    request: <T extends CatalogEntry>(
      entry: T,
      input: z.input<T["inputSchema"]>,
      options?: {
        readonly headers?: Record<string, string>;
        readonly pathParams?: Record<string, string>;
      },
    ): Promise<z.output<T["outputSchema"]>> =>
      execute(entry, input, options?.headers ?? {}, options?.pathParams),
  };
};
