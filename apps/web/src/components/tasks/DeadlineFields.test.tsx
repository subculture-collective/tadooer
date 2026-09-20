import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DeadlineFields, deadlineFromForm } from "./DeadlineFields.tsx";

describe("Deadline fields", () => {
  it("preserves date-only and explicit UTC instant semantics and supports clearing", () => {
    const form = new FormData();
    form.set("deadlineKind", "date");
    form.set("deadlineValue", "2026-11-01");
    expect(deadlineFromForm(form)).toEqual({
      kind: "date",
      value: "2026-11-01",
    });
    form.set("deadlineKind", "instant");
    form.set("deadlineValue", "2026-11-01T06:30");
    expect(deadlineFromForm(form)).toEqual({
      kind: "instant",
      value: "2026-11-01T06:30:00.000Z",
    });
    form.set("deadlineKind", "none");
    expect(deadlineFromForm(form)).toBeNull();
    form.set("deadlineKind", "date");
    form.set("deadlineValue", "2026-02-30");
    expect(() => deadlineFromForm(form)).toThrow();
  });

  it("labels timestamp inputs with their timezone", () => {
    const html = renderToStaticMarkup(
      <DeadlineFields
        deadline={{ kind: "instant", value: "2026-11-01T06:30:00.000Z" }}
      />,
    );
    expect(html).toContain("Deadline date and time (UTC)");
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain('value="2026-11-01T06:30:00.000"');
  });
});
