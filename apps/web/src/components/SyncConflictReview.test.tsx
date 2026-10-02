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

const noteReview = {
  conflict: {
    operationId: "00000000-0000-4000-8000-000000000003",
    taskId: "00000000-0000-4000-8000-000000000004",
    taskRevision: 3,
    conflictingFields: null,
    code: "SYNC_RESOURCE_CONFLICT" as const,
    entityKind: "note" as const,
  },
  canonical: null,
  attemptedFields: null,
  retryLocalSupported: true,
  retryLocalUnavailableReason: null,
  note: {
    canonical: {
      id: "00000000-0000-4000-8000-000000000004",
      ownerId: "00000000-0000-4000-8000-000000000005",
      content: "Text from the phone",
      projectId: null,
      tagId: null,
      pinnedToToday: false,
      position: 0,
      revision: 3,
      createdAt: "2026-10-02T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
    },
    attempted: "patch" as const,
    local: {
      content: "Text from this laptop",
      projectId: null,
      tagId: null,
      pinnedToToday: true,
    },
    keepBothSupported: true,
  },
};

it("shows both versions of a note conflict and every way to resolve it", () => {
  const markup = renderToStaticMarkup(
    <SyncConflictReview
      reviews={[noteReview]}
      busy={false}
      onResolve={vi.fn()}
    />,
  );

  expect(markup).toContain("Note conflict");
  expect(markup).toContain("Both versions are kept until you choose");
  expect(markup).toContain("Text from the phone");
  expect(markup).toContain("Text from this laptop");
  expect(markup).toContain("Keep current note");
  expect(markup).toContain("Save mine as a new note");
  expect(markup).toContain("Replace with mine");
});

it("offers only what applies when the note is gone or the change was a delete", () => {
  const gone = renderToStaticMarkup(
    <SyncConflictReview
      reviews={[
        {
          ...noteReview,
          retryLocalSupported: false,
          retryLocalUnavailableReason: "unsupported" as const,
          note: { ...noteReview.note, canonical: null },
        },
      ]}
      busy={false}
      onResolve={vi.fn()}
    />,
  );
  expect(gone).toContain("no longer exists on the server");
  expect(gone).toContain("Text from this laptop");
  expect(gone).toContain("Save mine as a new note");
  expect(gone).toContain("Dismiss");
  expect(gone).not.toContain("Replace with mine");

  const removal = renderToStaticMarkup(
    <SyncConflictReview
      reviews={[
        {
          ...noteReview,
          note: {
            ...noteReview.note,
            attempted: "delete" as const,
            local: null,
            keepBothSupported: false,
          },
        },
      ]}
      busy={false}
      onResolve={vi.fn()}
    />,
  );
  expect(removal).toContain("You deleted this note");
  expect(removal).toContain("Text from the phone");
  expect(removal).toContain("Delete the current note");
  expect(removal).not.toContain("Save mine as a new note");

  const pending = renderToStaticMarkup(
    <SyncConflictReview
      reviews={[
        {
          ...noteReview,
          retryLocalSupported: false,
          retryLocalUnavailableReason: "pending-local-sync" as const,
        },
      ]}
      busy={false}
      onResolve={vi.fn()}
    />,
  );
  expect(pending).toContain(
    "A newer local change to this note is still syncing",
  );
  expect(pending).not.toContain("Replace with mine");
});
