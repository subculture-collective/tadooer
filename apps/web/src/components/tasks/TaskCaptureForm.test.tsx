import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskCaptureForm } from "./TaskCaptureForm.tsx";

// ADR 0031: the consent box is part of the same form submit; the paste
// preview and URL setting are online-only and need a session token.
describe("TaskCaptureForm", () => {
  const submit = () => Promise.resolve();

  it("offers explicit consent for new tags next to the marker switch", () => {
    const markup = renderToStaticMarkup(
      <TaskCaptureForm busy={false} onSubmit={submit} />,
    );
    expect(markup).toContain('name="structured"');
    expect(markup).toContain('name="createTags"');
    expect(markup).toContain("Create unknown #tags with this task");
    expect(markup).toContain("30m or 1h30m");
    expect(markup).toContain("@every monday");
    expect(markup).not.toContain("Paste a Markdown list");
    expect(markup).not.toContain('name="urlBehavior"');
  });

  it("renders the paste preview and URL setting only with a session token", () => {
    const markup = renderToStaticMarkup(
      <TaskCaptureForm busy={false} onSubmit={submit} csrfToken="token" />,
    );
    expect(markup).toContain("Paste a Markdown list or an email");
    expect(markup).toContain("Preview tasks");
    expect(markup).toContain('name="urlBehavior"');
    expect(markup).toContain('value="keep_and_attach"');
    expect(markup).not.toContain("Create 0 tasks");
  });
});
