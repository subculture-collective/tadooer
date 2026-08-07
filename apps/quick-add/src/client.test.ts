import { describe, expect, it } from "vitest";
import { submitQuickAdd, type FetchLike } from "./client.ts";

const id = "d1054acd-c04d-4bd8-a814-254b007154ba";
const task = {
  id,
  title: "Capture inbox",
  notes: "from terminal",
  status: "open",
  revision: 1,
  createdAt: "2026-08-06T16:00:00.000Z",
  updatedAt: "2026-08-06T16:00:00.000Z",
  completedAt: null,
  deletedAt: null,
  plannedStart: null,
  estimateMinutes: null,
  projectId: null,
  tagIds: [],
};

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
});

describe("quick-add automation HTTP client", () => {
  it("uses only preview then confirmation with one caller-provided key", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const mockFetch: FetchLike = (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1)
        return Promise.resolve(
          jsonResponse({
            preview: {
              id,
              operation: "tasks.create",
              inputHash: "a".repeat(64),
              summary: "Create one task",
              affected: [],
              baseRevisions: [],
              expiresAt: "2026-08-06T16:10:00.000Z",
              requiresConfirmation: true,
            },
          }),
        );
      return Promise.resolve(
        jsonResponse({
          previewId: id,
          operation: "tasks.create",
          replayed: false,
          result: { task, replayed: false },
        }),
      );
    };

    const result = await submitQuickAdd(
      {
        baseUrl: "https://suite.example",
        idempotencyKey: "capture-inbox-20260806",
        title: task.title,
        notes: task.notes,
      },
      `suite_at_${id}.${"A".repeat(43)}`,
      mockFetch,
    );

    expect(result.replayed).toBe(false);
    expect(calls.map(({ url }) => url)).toEqual([
      "https://suite.example/api/automation/v1/previews",
      `https://suite.example/api/automation/v1/previews/${id}/confirm`,
    ]);
    expect(calls[0]?.init.body).toBe(
      JSON.stringify({
        operation: "tasks.create",
        input: { title: task.title, notes: task.notes },
      }),
    );
    expect(calls[1]?.init.body).toBe(
      JSON.stringify({ idempotencyKey: "capture-inbox-20260806" }),
    );
    expect(calls.every(({ url }) => !url.includes("/api/tasks"))).toBe(true);
  });

  it("returns the bounded Suite error rather than continuing to confirmation", async () => {
    const mockFetch: FetchLike = () =>
      Promise.resolve(
        jsonResponse(
          {
            code: "AUTOMATION_SCOPE_DENIED",
            message: "Task write scope required",
          },
          403,
        ),
      );
    await expect(
      submitQuickAdd(
        {
          baseUrl: "https://suite.example",
          idempotencyKey: "capture-inbox-20260806",
          title: task.title,
          notes: task.notes,
        },
        `suite_at_${id}.${"A".repeat(43)}`,
        mockFetch,
      ),
    ).rejects.toThrow("AUTOMATION_SCOPE_DENIED");
  });
});
