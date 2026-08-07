import {
  automationConfirmationResponseSchema,
  automationPreviewResponseSchema,
  type AutomationConfirmationResponse,
} from "@suite/contracts";
import type { QuickAddConfig } from "./config.ts";

export type FetchLike = (
  input: string,
  init: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "json">>;

const errorFor = async (
  response: Pick<Response, "status" | "json">,
): Promise<Error> => {
  try {
    const body = (await response.json()) as {
      code?: unknown;
      message?: unknown;
    };
    const code =
      typeof body.code === "string" ? body.code : "AUTOMATION_REQUEST_FAILED";
    const message =
      typeof body.message === "string"
        ? body.message
        : "Suite automation request failed";
    return new Error(`${code}: ${message}`);
  } catch {
    return new Error(
      `AUTOMATION_REQUEST_FAILED: Suite returned HTTP ${response.status}`,
    );
  }
};

const requestHeaders = (token: string): Readonly<Record<string, string>> => ({
  Accept: "application/json",
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

export const submitQuickAdd = async (
  config: Pick<
    QuickAddConfig,
    "baseUrl" | "idempotencyKey" | "title" | "notes"
  >,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<AutomationConfirmationResponse> => {
  const preview = await fetchImpl(
    `${config.baseUrl}/api/automation/v1/previews`,
    {
      method: "POST",
      headers: requestHeaders(token),
      body: JSON.stringify({
        operation: "tasks.create",
        input: { title: config.title, notes: config.notes },
      }),
    },
  );
  if (!preview.ok) throw await errorFor(preview);
  const previewBody = automationPreviewResponseSchema.safeParse(
    await preview.json(),
  );
  if (!previewBody.success)
    throw new Error(
      "AUTOMATION_PROTOCOL_INVALID: Suite preview response is invalid",
    );

  const confirmation = await fetchImpl(
    `${config.baseUrl}/api/automation/v1/previews/${encodeURIComponent(previewBody.data.preview.id)}/confirm`,
    {
      method: "POST",
      headers: requestHeaders(token),
      body: JSON.stringify({ idempotencyKey: config.idempotencyKey }),
    },
  );
  if (!confirmation.ok) throw await errorFor(confirmation);
  const confirmed = automationConfirmationResponseSchema.safeParse(
    await confirmation.json(),
  );
  if (!confirmed.success)
    throw new Error(
      "AUTOMATION_PROTOCOL_INVALID: Suite confirmation response is invalid",
    );
  return confirmed.data;
};
