import { describe, expect, it } from "vitest";
import {
  defaultFocusPreferences,
  syncEntitySnapshotSchema,
  syncKnownEntityKinds,
} from "./index.ts";

describe("issue #114 focus preference sync contract", () => {
  it("carries saved preferences and revision-zero defaults as one feed record", () => {
    const snapshot = {
      entityKind: "focus_preferences" as const,
      value: {
        id: "10000000-0000-4000-8000-000000000001",
        preferences: defaultFocusPreferences,
        revision: 0,
        imported: null,
      },
    };
    expect(syncEntitySnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(syncKnownEntityKinds).toContain("focus_preferences");
  });
});
