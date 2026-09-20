import { describe, expect, it } from "vitest";
import { updateHiddenCalendarIds } from "./TodayPage.tsx";

describe("updateHiddenCalendarIds", () => {
  it("can hide and then show the same calendar without retaining stale state", () => {
    const hidden = updateHiddenCalendarIds([], "calendar-work", false);
    expect(hidden).toEqual(["calendar-work"]);
    expect(updateHiddenCalendarIds(hidden, "calendar-work", true)).toEqual([]);
  });

  it("does not duplicate a hidden calendar", () => {
    expect(
      updateHiddenCalendarIds(["calendar-work"], "calendar-work", false),
    ).toEqual(["calendar-work"]);
  });
});
