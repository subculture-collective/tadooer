import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./button.tsx";
import { Input } from "./input.tsx";

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
});
