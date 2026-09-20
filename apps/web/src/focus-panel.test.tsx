import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ActiveSession, Task } from "@suite/contracts";
import { FocusPanel } from "./focus-panel.tsx";

const task: Task = {
  id: "afcab502-2199-43fd-b9d3-c8b556c6f25b",
  title: "Write the project brief",
  notes: "",
  status: "open",
  revision: 1,
  createdAt: "2026-08-06T12:00:00.000Z",
  updatedAt: "2026-08-06T12:00:00.000Z",
  completedAt: null,
  deletedAt: null,
  plannedStart: null,
  estimateMinutes: null,
};

const runningSession: ActiveSession = {
  id: "df8c5e63-3280-4d25-b148-2d0e46e9a19d",
  ownerId: "c6d3a6fa-12c1-4d49-9544-5f85d885e7bc",
  taskId: task.id,
  controllerClientId: "1280d3ef-5f2f-4ac6-90ed-74e60b7157e6",
  state: "running",
  phase: "focus",
  revision: 3,
  startedAt: "2026-08-06T12:00:00.000Z",
  updatedAt: "2026-08-06T12:05:00.000Z",
  leaseExpiresAt: "2026-08-06T12:10:00.000Z",
  hardExpiresAt: "2026-08-06T20:00:00.000Z",
  currentIntervalId: "47f178b0-4f32-4426-a974-13d3592a7c2c",
};

const render = (activeSession: ActiveSession | null, clientId: string | null) =>
  renderToStaticMarkup(
    <FocusPanel
      tasks={[task]}
      activeSession={activeSession}
      clientId={clientId}
      busy={false}
      online
      onCommand={() => undefined}
    />,
  );

describe("FocusPanel", () => {
  it("offers an open task selector and start action when no session is active", () => {
    const markup = render(null, "1280d3ef-5f2f-4ac6-90ed-74e60b7157e6");
    expect(markup).toContain("Focus task");
    expect(markup).toContain("Write the project brief");
    expect(markup).toContain("Start focus");
  });

  it("can omit the duplicate all-task start selector while retaining session controls", () => {
    const terminal = renderToStaticMarkup(
      <FocusPanel
        tasks={[task]}
        activeSession={null}
        clientId={task.id}
        busy={false}
        online
        onCommand={() => undefined}
        showStartForm={false}
      />,
    );
    expect(terminal).not.toContain("Focus task");
    const running = render(
      runningSession,
      "1280d3ef-5f2f-4ac6-90ed-74e60b7157e6",
    );
    expect(running).toContain("Pause");
  });

  it("renders owner-only controls for the controlling client", () => {
    const markup = render(
      runningSession,
      "1280d3ef-5f2f-4ac6-90ed-74e60b7157e6",
    );
    expect(markup).toContain("Pause");
    expect(markup).toContain("Start break");
    expect(markup).toContain("Complete focus session");
    expect(markup).not.toContain("Take over on this device");
  });

  it("renders a read-only follower state with explicit takeover", () => {
    const markup = render(
      runningSession,
      "e1432ff2-025d-4151-9eb2-9e22f089ffb4",
    );
    expect(markup).toContain("Controlled on another registered device.");
    expect(markup).toContain("Take over on this device");
    expect(markup).not.toContain("Complete focus session");
  });

  it("draws an explicit expired-session boundary before a new start", () => {
    const markup = render(
      {
        ...runningSession,
        state: "expired",
        controllerClientId: null,
        leaseExpiresAt: null,
        currentIntervalId: null,
      },
      "1280d3ef-5f2f-4ac6-90ed-74e60b7157e6",
    );
    expect(markup).toContain(
      "This focus session expired. Start a new session to continue.",
    );
    expect(markup).toContain("Start focus");
    expect(markup).not.toContain("Take over on this device");
  });
});
