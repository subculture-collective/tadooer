import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChoicePoolLibrary } from "./choice-pool-library.tsx";

describe("ChoicePoolLibrary", () => {
  it("keeps candidates in an explicit preview and confirmation surface", () => {
    const now = "2026-08-07T12:00:00.000Z";
    const markup = renderToStaticMarkup(
      <ChoicePoolLibrary
        pools={[
          {
            id: "00000000-0000-4000-8000-000000000001",
            ownerId: "00000000-0000-4000-8000-000000000002",
            title: "Exercises",
            policy: "cycle",
            pickCount: 1,
            cooldownSeconds: null,
            revision: 1,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
          },
        ]}
        items={[
          {
            id: "00000000-0000-4000-8000-000000000003",
            poolId: "00000000-0000-4000-8000-000000000001",
            title: "Squat",
            position: 0,
            revision: 1,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
          },
        ]}
        history={[]}
        placeholders={[
          {
            id: "00000000-0000-4000-8000-000000000004",
            ownerId: "00000000-0000-4000-8000-000000000002",
            taskId: "00000000-0000-4000-8000-000000000005",
            poolId: "00000000-0000-4000-8000-000000000001",
            pickCount: 1,
            state: "unresolved",
            revision: 1,
            createdAt: now,
            updatedAt: now,
            resolvedAt: null,
          },
        ]}
        tasks={[
          {
            id: "00000000-0000-4000-8000-000000000005",
            title: "Leg day",
            notes: "",
            status: "open",
            revision: 1,
            createdAt: now,
            updatedAt: now,
            completedAt: null,
            deletedAt: null,
            plannedStart: null,
            estimateMinutes: null,
            projectId: null,
            tagIds: [],
          },
        ]}
        busy={false}
        onCreatePool={async () => undefined}
        onCreatePlaceholder={async () => undefined}
        onSuggest={async () => {
          throw new Error("not invoked during SSR");
        }}
        onResolve={async () => undefined}
      />,
    );
    expect(markup).toContain("Choice Pools");
    expect(markup).toContain("Squat");
    expect(markup).toContain("Preview eligible choices");
    expect(markup).not.toContain("Confirm resolution");
  });
});
