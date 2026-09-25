import { expect, it } from "vitest";
import {
  automationNoteMutationInputSchema,
  automationProjectMutationInputSchema,
  noteCreateRequestSchema,
  notePatchRequestSchema,
  organizationIconSchema,
  projectPatchRequestSchema,
  projectSchema,
  tagPatchRequestSchema,
} from "./index.ts";

const id = "5b7c3f1e-5d2a-4c2e-9d0e-1f2a3b4c5d6e";

it("accepts icon names and single emoji but never markup or URLs", () => {
  for (const icon of ["work", "wb_sunny", "🚀", "🏷️", "👍🏽", "🇺🇸"])
    expect(organizationIconSchema.safeParse(icon).success, icon).toBe(true);
  for (const icon of ["", "Work", "<b>", "https://x", "a b", "🚀 launch"])
    expect(organizationIconSchema.safeParse(icon).success, icon).toBe(false);
});

it("separates project-only fields from tag edits", () => {
  expect(
    projectPatchRequestSchema.safeParse({
      completed: true,
      color: "#AABBCC",
      hiddenFromMenu: true,
      backlogEnabled: false,
    }).success,
  ).toBe(true);
  expect(projectPatchRequestSchema.safeParse({ color: "red" }).success).toBe(
    false,
  );
  expect(tagPatchRequestSchema.safeParse({ completed: true }).success).toBe(
    false,
  );
  expect(tagPatchRequestSchema.safeParse({ archived: false }).success).toBe(
    true,
  );
});

it("reads project snapshots cached before migration 0022", () => {
  expect(
    projectSchema.parse({
      id,
      ownerId: id,
      title: "Old",
      revision: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      archivedAt: null,
    }),
  ).toMatchObject({
    color: null,
    icon: null,
    position: 0,
    hiddenFromMenu: false,
    completedAt: null,
    backlogEnabled: false,
    backlogTaskIds: [],
  });
});

it("validates note association, content and assistant commands", () => {
  expect(noteCreateRequestSchema.parse({ content: "Hello" })).toEqual({
    content: "Hello",
    projectId: null,
    tagId: null,
    pinnedToToday: false,
  });
  expect(noteCreateRequestSchema.safeParse({ content: "  " }).success).toBe(
    false,
  );
  expect(
    noteCreateRequestSchema.safeParse({
      content: "x",
      projectId: id,
      tagId: id,
    }).success,
  ).toBe(false);
  expect(notePatchRequestSchema.safeParse({}).success).toBe(false);
  expect(
    notePatchRequestSchema.safeParse({ content: "x".repeat(20_001) }).success,
  ).toBe(false);
  expect(
    automationNoteMutationInputSchema.safeParse({
      action: "reorder",
      items: [
        { id, revision: 1 },
        { id, revision: 1 },
      ],
    }).success,
  ).toBe(false);
  expect(
    automationProjectMutationInputSchema.safeParse({
      action: "configure",
      id,
      expectedRevision: 1,
    }).success,
  ).toBe(false);
  expect(
    automationProjectMutationInputSchema.safeParse({
      action: "complete",
      id,
      expectedRevision: 1,
    }).success,
  ).toBe(true);
});
