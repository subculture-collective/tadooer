import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { SyncConflictReview } from "./SyncConflictReview.tsx";

const review = {
  conflict: {
    operationId: "00000000-0000-4000-8000-000000000001",
    taskId: "00000000-0000-4000-8000-000000000002",
    taskRevision: 2,
    conflictingFields: ["deadline"] as const,
    code: "SYNC_FIELD_CONFLICT" as const,
  },
  canonical: {
    task: {
      id: "00000000-0000-4000-8000-000000000002",
      title: "Canonical task",
      notes: "",
      status: "open" as const,
      revision: 2,
      createdAt: "2026-09-24T00:00:00.000Z",
      updatedAt: "2026-09-24T00:00:00.000Z",
      completedAt: null,
      deletedAt: null,
      plannedStart: null,
      estimateMinutes: null,
      deadline: { kind: "date" as const, value: "2026-10-01" },
      projectId: null,
      tagIds: [],
    },
    fieldVersions: {
      title: 2,
      notes: 2,
      status: 2,
      estimateMinutes: 2,
      projectId: 2,
      tagIds: 2,
      deadline: 2,
    },
    changeSequence: 2,
  },
  attemptedFields: {
    title: "Local title",
    deadline: { kind: "date" as const, value: "2026-09-30" },
  },
  retryLocalSupported: true,
  retryLocalUnavailableReason: null,
};

it("shows canonical and attempted task values with explicit resolution controls", () => {
  const markup = renderToStaticMarkup(
    <SyncConflictReview reviews={[review]} busy={false} onResolve={vi.fn()} />,
  );

  expect(markup).toContain("Sync conflicts need review");
  expect(markup).toContain("Current value");
  expect(markup).toContain("Local attempted value");
  expect(markup).toContain("2026-10-01");
  expect(markup).toContain("2026-09-30");
  expect(markup).toContain("Local title");
  expect(markup).toContain("Keep current values");
  expect(markup).toContain("Retry local values");
});

it("explains that a newer local task change must finish syncing", () => {
  const markup = renderToStaticMarkup(
    <SyncConflictReview
      reviews={[
        {
          ...review,
          retryLocalSupported: false,
          retryLocalUnavailableReason: "pending-local-sync",
        },
      ]}
      busy={false}
      onResolve={vi.fn()}
    />,
  );

  expect(markup).toContain("A newer local change is still syncing");
  expect(markup).toContain("Wait for the newer local task change");
});

it("keeps an unsupported conflict visible without retry controls", () => {
  const markup = renderToStaticMarkup(
    <SyncConflictReview
      reviews={[{ ...review, retryLocalSupported: false }]}
      busy={false}
      onResolve={vi.fn()}
    />,
  );

  expect(markup).toContain("Manual review required");
  expect(markup).not.toContain("Retry local values");
});
