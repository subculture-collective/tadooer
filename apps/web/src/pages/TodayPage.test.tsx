import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { noteSchema } from "@suite/contracts";
import {
  TodayPage,
  updateHiddenCalendarIds,
  type TodayPageProps,
} from "./TodayPage.tsx";

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

describe("pinned notes (ADR 0046)", () => {
  const props: TodayPageProps = {
    dayPlan: undefined,
    planningPreferences: undefined,
    tasks: [],
    activeSession: null,
    clientId: null,
    syncStatus: "offline",
    planner: null,
    baikalCalendars: [],
    calendarActionsAvailable: false,
    focusActionsAvailable: false,
    busy: false,
    onFocusCommand: () => undefined,
    onSubmitTask: () => Promise.resolve(),
    onChangeTaskStatus: () => Promise.resolve(false),
    onSubmitTimeBlock: () => Promise.resolve(),
    onRemoveTimeBlock: () => Promise.resolve(),
    onViewTasks: () => undefined,
  };
  const note = noteSchema.parse({
    id: "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d",
    ownerId: "5b7c3f1e-5d2a-4c2e-9d0e-1f2a3b4c5d6e",
    content: "Water the **seedlings**",
    projectId: null,
    tagId: null,
    pinnedToToday: true,
    position: 0,
    revision: 1,
    createdAt: "2026-10-02T12:00:00.000Z",
    updatedAt: "2026-10-02T12:00:00.000Z",
  });

  it("renders cached pinned notes with no connection and no session", () => {
    const html = renderToStaticMarkup(
      <TodayPage {...props} pinnedNotes={[note]} />,
    );
    expect(html).toContain("Pinned notes");
    expect(html).toContain("Water the <strong>seedlings</strong>");
  });

  it("shows no pinned notes section when nothing is pinned", () => {
    expect(renderToStaticMarkup(<TodayPage {...props} />)).not.toContain(
      "Pinned notes",
    );
  });
});
