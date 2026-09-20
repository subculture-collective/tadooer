import { describe, expect, it } from "vitest";
import { cn } from "./utils.ts";

describe("cn", () => {
  it("merges conditional class names", () => {
    expect(cn("base", false, undefined, "active")).toBe("base active");
  });
});
