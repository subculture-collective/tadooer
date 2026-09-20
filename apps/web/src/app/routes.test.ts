import { describe, expect, it } from "vitest";
import { routeFromPath } from "./routes.ts";

describe("routeFromPath", () => {
  it.each([
    ["/today", "today"],
    ["/tasks", "tasks"],
    ["/unknown", "today"],
  ] as const)("maps %s to %s", (path, expected) => {
    expect(routeFromPath(path)).toBe(expected);
  });
});
