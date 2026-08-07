import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TemplateLibrary } from "./template-library.tsx";

const props = {
  templates: [
    {
      id: "d1054acd-c04d-4bd8-a814-254b007154ba",
      title: "Weekly review",
      notes: "Look back before planning ahead.",
      estimateMinutes: 30,
      suggestedProjectId: "1b34cc57-972c-42e8-bafa-0ba455dced20",
      tagIds: [],
      revision: 1,
      archivedAt: null,
    },
  ],
  blueprints: [
    {
      id: "afcab502-2199-43fd-b9d3-c8b556c6f25b",
      templateId: "d1054acd-c04d-4bd8-a814-254b007154ba",
      title: "Review completed work",
      position: 0,
    },
  ],
  sets: [
    {
      id: "728a504a-0997-4eb3-94dd-5d6ff8af5967",
      title: "Friday closeout",
      archivedAt: null,
    },
  ],
  projects: [{ id: "1b34cc57-972c-42e8-bafa-0ba455dced20", title: "Personal" }],
  tags: [],
  busy: false,
  onCreate: vi.fn(() => Promise.resolve()),
  onSearch: vi.fn(),
  onArchive: vi.fn(() => Promise.resolve()),
  onEdit: vi.fn(() => Promise.resolve()),
  onCreateSet: vi.fn(() => Promise.resolve()),
  onInstantiate: vi.fn(() => Promise.resolve()),
  onInstantiateSet: vi.fn(() => Promise.resolve()),
};

describe("TemplateLibrary", () => {
  it("keeps inert templates in a distinct, accessible library with explicit destinations", () => {
    const markup = renderToStaticMarkup(<TemplateLibrary {...props} />);

    expect(markup).toContain("Template Library");
    expect(markup).toContain("Templates are inert blueprints");
    expect(markup).toContain("Search templates");
    expect(markup).toContain("New template");
    expect(markup).toContain("Weekly review");
    expect(markup).toContain("Review completed work");
    expect(markup).toContain("Existing destination project");
    expect(markup).toContain("Create task");
    expect(markup).toContain("Archive template");
    expect(markup).toContain("Edit template");
    expect(markup).toContain("Save template");
    expect(markup).toContain("Template Sets");
    expect(markup).toContain("Set name");
    expect(markup).toContain("Templates in this set");
    expect(markup).toContain("Save set");
    expect(markup).toContain("Friday closeout");
    expect(markup).toContain("Create set");
  });
});
