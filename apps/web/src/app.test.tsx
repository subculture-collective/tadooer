import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./app.tsx";

describe("App", () => {
  it("renders explicit readiness evidence without claiming product behavior", () => {
    const markup = renderToStaticMarkup(
      <App
        initialState={{
          kind: "ready",
          status: {
            health: {
              service: "productivity-suite",
              status: "ok",
              timestamp: "2026-08-05T00:00:00.000Z",
            },
            readiness: {
              service: "productivity-suite",
              status: "ok",
              checks: { database: "ok", migrations: "current" },
              instanceId: "d1054acd-c04d-4bd8-a814-254b007154ba",
              migrationCount: 1,
              timestamp: "2026-08-05T00:00:00.000Z",
            },
            build: {
              service: "productivity-suite",
              version: "0.0.0-test",
              revision: "abc123def456",
              builtAt: null,
            },
          },
        }}
      />,
    );

    expect(markup).toContain("Foundation ready");
    expect(markup).toContain("SQLite and 1 migration verified.");
    expect(markup).toContain("No task or calendar product behavior");
    expect(markup).toContain("d1054acd");
  });
});
