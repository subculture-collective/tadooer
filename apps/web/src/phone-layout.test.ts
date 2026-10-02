import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), "utf8");

describe("phone layout contract", () => {
  it("declares an edge-to-edge viewport that resizes with the keyboard", () => {
    const meta = /<meta\s+name="viewport"\s+content="([^"]*)"/.exec(
      read("../index.html"),
    );
    const directives = (meta?.[1] ?? "").split(",").map((part) => part.trim());

    expect(directives).toEqual([
      "width=device-width",
      "initial-scale=1.0",
      "viewport-fit=cover",
      "interactive-widget=resizes-content",
    ]);
  });

  it("sizes full-height layout from the dynamic viewport", () => {
    for (const sheet of [
      "./styles.css",
      "./components/calendar/planner-time-grid.css",
    ]) {
      expect(read(sheet)).not.toMatch(/\b100vh\b/);
    }
  });

  it("pads the shell and overlays for device safe areas", () => {
    const styles = read("./styles.css");

    for (const side of ["top", "right", "bottom", "left"]) {
      expect(styles).toContain(`env(safe-area-inset-${side}, 0px)`);
    }
  });
});
