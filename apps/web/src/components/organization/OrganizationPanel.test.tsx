import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  noteSchema,
  projectSchema,
  tagSchema,
  type Task,
} from "@suite/contracts";
import { OrganizationPanel, type NoteQueue } from "./OrganizationPanel.tsx";

const ownerId = "5b7c3f1e-5d2a-4c2e-9d0e-1f2a3b4c5d6e";
const at = "2026-09-24T12:00:00.000Z";
const project = projectSchema.parse({
  id: "0e5d1a7f-3c2b-4a19-8e6d-2b3c4d5e6f70",
  ownerId,
  title: "Garden",
  revision: 3,
  createdAt: at,
  updatedAt: at,
  archivedAt: at,
  completedAt: at,
  color: "#336699",
  icon: "yard",
  backlogEnabled: true,
  backlogTaskIds: ["7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"],
});
const tag = tagSchema.parse({
  id: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b",
  ownerId,
  displayName: "Calls",
  normalizedName: "calls",
  revision: 1,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
});
const task = {
  id: "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  title: "Plant bulbs",
  projectId: project.id,
} as unknown as Task;

it("shows lifecycle, appearance, backlog and offline state for organization records", () => {
  const html = renderToStaticMarkup(
    <OrganizationPanel
      projects={[project]}
      tags={[tag]}
      tasks={[task]}
      csrfToken="csrf"
      online={false}
      onProjectsChange={() => undefined}
      onTagsChange={() => undefined}
    />,
  );
  expect(html).toContain("Organization changes need a connection");
  expect(html).toContain(
    "Notes are shown from this device and cannot be changed here",
  );
  expect(html).toContain("No notes here.");
  expect(html).toContain("Completed");
  expect(html).toContain("Reopen Garden");
  expect(html).toContain("Restore Garden");
  expect(html).toContain("background-color:#336699");
  expect(html).toContain("yard");
  expect(html).toContain("Plant bulbs");
  expect(html).toContain("Move to active");
  expect(html).toContain("Archive Calls");
  expect(html).toContain("Notes use Markdown");
  // Without a note queue, every note write control is disabled.
  expect(html).not.toMatch(/<button(?![^>]* disabled="")[^>]*>Add note/);
});

it("renders cached notes offline with enabled write controls (ADR 0046)", () => {
  const note = (id: string, extra: object) =>
    noteSchema.parse({
      id,
      ownerId,
      content: "",
      projectId: null,
      tagId: null,
      pinnedToToday: false,
      position: 0,
      revision: 1,
      createdAt: at,
      updatedAt: at,
      ...extra,
    });
  const noteQueue: NoteQueue = {
    create: () => Promise.resolve(),
    patch: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    swap: () => Promise.resolve(),
  };
  const html = renderToStaticMarkup(
    <OrganizationPanel
      projects={[project]}
      tags={[tag]}
      tasks={[task]}
      csrfToken="csrf"
      online={false}
      onProjectsChange={() => undefined}
      onTagsChange={() => undefined}
      notes={[
        note("2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d", {
          content: "**Soil** mix",
          projectId: project.id,
          pinnedToToday: true,
        }),
        note("3b4c5d6e-7f8a-4b9c-8d1e-2f3a4b5c6d7e", {
          content: "Call back",
          tagId: tag.id,
          position: 1,
        }),
      ]}
      noteQueue={noteQueue}
    />,
  );
  // The notes come from the cache: no request is needed to show them.
  expect(html).toContain("<strong>Soil</strong> mix");
  expect(html).toContain("Call back");
  expect(html).toContain("Project: Garden");
  expect(html).toContain("Tag: Calls");
  expect(html).toContain("Pinned to Today");
  expect(html).toContain("Notes are saved on this device and sync later");
  expect(html).not.toContain("No notes here.");
  // Offline, note writes stay enabled while online-only controls do not.
  expect(html).toMatch(/<button(?![^>]* disabled="")[^>]*>Add note/);
  expect(html).toMatch(/<button(?![^>]* disabled="")[^>]*>Unpin/);
  expect(html).toMatch(/<button(?![^>]* disabled="")[^>]*>Delete note/);
  // The first note cannot move up; the last cannot move down.
  expect(html.match(/<button[^>]* disabled=""[^>]*>Move up/g)).toHaveLength(1);
  expect(html.match(/<button[^>]* disabled=""[^>]*>Move down/g)).toHaveLength(
    1,
  );
});
