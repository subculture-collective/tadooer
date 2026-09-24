import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Alert, AlertDescription, AlertTitle } from "./alert.tsx";
import { Button } from "./button.tsx";
import { Checkbox } from "./checkbox.tsx";
import { Input } from "./input.tsx";
import { NativeSelect } from "./native-select.tsx";
import { PageHeader } from "./page-header.tsx";

describe("UI primitives", () => {
  it("renders disabled buttons with native semantics", () => {
    const markup = renderToStaticMarkup(<Button disabled>Save</Button>);

    expect(markup).toContain("disabled");
    expect(markup).toContain('data-slot="button"');
  });

  it("preserves input labels and identifiers", () => {
    const markup = renderToStaticMarkup(
      <label htmlFor="title">
        Title
        <Input id="title" />
      </label>,
    );

    expect(markup).toContain('for="title"');
    expect(markup).toContain('id="title"');
  });

  it("renders a native select that keeps its form name", () => {
    const markup = renderToStaticMarkup(
      <label className="field">
        <span>Priority</span>
        <NativeSelect name="priority" defaultValue="high">
          <option value="low">Low</option>
          <option value="high">High</option>
        </NativeSelect>
      </label>,
    );

    expect(markup).toContain('<select data-slot="native-select"');
    expect(markup).toContain('name="priority"');
    expect(markup).toContain('<option value="high" selected="">High</option>');
  });

  it("renders the checkbox root with its slot", () => {
    const markup = renderToStaticMarkup(<Checkbox aria-label="Done" />);

    expect(markup).toContain('data-slot="checkbox"');
    expect(markup).toContain('role="checkbox"');
    expect(markup).toContain('aria-label="Done"');
  });

  it("renders alert variants with their tint classes", () => {
    const destructive = renderToStaticMarkup(
      <Alert variant="destructive">
        <AlertTitle>Sync failed</AlertTitle>
        <AlertDescription>Retry in a minute.</AlertDescription>
      </Alert>,
    );
    const success = renderToStaticMarkup(
      <Alert variant="success">Saved</Alert>,
    );
    const plain = renderToStaticMarkup(<Alert>Plain</Alert>);

    expect(destructive).toContain('role="alert"');
    expect(destructive).toContain('data-variant="destructive"');
    expect(destructive).toContain("bg-destructive/15");
    expect(destructive).toContain("border-destructive/40");
    expect(destructive).toContain('data-slot="alert-title"');
    expect(success).toContain("bg-success/15");
    expect(plain).toContain('data-variant="default"');
    expect(plain).not.toContain("destructive");
  });

  it("renders the page header title as an h1", () => {
    const markup = renderToStaticMarkup(
      <PageHeader
        eyebrow="Step 1"
        title="Today"
        description="Plan the day."
        actions={<Button>New task</Button>}
      />,
    );

    expect(markup).toContain('data-slot="page-header"');
    expect(markup).toMatch(/<h1[^>]*>Today<\/h1>/);
    expect(markup).toContain("Step 1");
    expect(markup).toContain('data-slot="page-header-actions"');
  });
});
