import {
  createAutomationClient,
  type AutomationConfirmationResponse,
  automationCatalog,
  automationConfirmationResponseSchema,
  automationConfirmRequestSchema,
} from "@suite/contracts";
import type { QuickAddConfig } from "./config.ts";

/**
 * Creates a task through the two-phase automation protocol
 * (preview → confirm) using the shared catalog-typed client.
 */
export const submitQuickAdd = async (
  config: Pick<
    QuickAddConfig,
    | "baseUrl"
    | "idempotencyKey"
    | "title"
    | "notes"
    | "structured"
    | "createTags"
  >,
  token: string,
): Promise<AutomationConfirmationResponse> => {
  const client = createAutomationClient(config.baseUrl);
  const authHeaders = { Authorization: `Bearer ${token}` };

  const taskCreateEntry = automationCatalog.find(
    (e) => e.id === "tasks.create",
  );
  if (!taskCreateEntry)
    throw new Error("tasks.create not found in automation catalog");

  const previewResponse = (await client.request(
    taskCreateEntry,
    {
      operation: "tasks.create" as const,
      input: {
        title: config.title,
        notes: config.notes,
        ...(config.structured === true ? { structured: true } : {}),
      },
    },
    { headers: authHeaders },
  )) as {
    readonly preview: {
      readonly id: string;
      readonly summary: string;
      readonly affected: readonly {
        readonly entityKind: string;
        readonly entityId: string;
      }[];
    };
  };

  // ADR 0031: the preview names every tag it would create. Without explicit
  // consent the CLI stops before confirmation and creates nothing.
  const newTags = previewResponse.preview.affected.filter(
    (entry) => entry.entityKind === "tag",
  );
  if (newTags.length > 0 && config.createTags !== true)
    throw new Error(
      `Capture would create ${String(newTags.length)} new ${newTags.length === 1 ? "tag" : "tags"} (${previewResponse.preview.summary}). Re-run with --create-tags to confirm.`,
    );

  const previewId = previewResponse.preview.id;

  const confirmEntry = {
    kind: "tool" as const,
    apiPath: "/api/automation/v1/previews/{previewId}/confirm",
    inputSchema: automationConfirmRequestSchema,
    outputSchema: automationConfirmationResponseSchema,
  };

  return client.request(
    confirmEntry,
    { idempotencyKey: config.idempotencyKey },
    {
      headers: authHeaders,
      pathParams: { previewId },
    },
  );
};
