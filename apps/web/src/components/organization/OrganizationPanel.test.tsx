import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { projectSchema, tagSchema, type Task } from "@suite/contracts";
import { OrganizationPanel } from "./OrganizationPanel.tsx";

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
  expect(html).toContain("Organization changes and notes need a connection");
  expect(html).toContain("Completed");
  expect(html).toContain("Reopen Garden");
  expect(html).toContain("Restore Garden");
  expect(html).toContain("background-color:#336699");
  expect(html).toContain("yard");
  expect(html).toContain("Plant bulbs");
  expect(html).toContain("Move to active");
  expect(html).toContain("Archive Calls");
  expect(html).toContain("Notes use Markdown");
  // Offline, every write control is disabled.
  expect(html).not.toMatch(/<button(?![^>]*disabled)[^>]*>Add note/);
});
