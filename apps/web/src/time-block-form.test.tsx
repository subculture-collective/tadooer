import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Task } from "@suite/contracts";
import { TimeBlockForm } from "./time-block-form.tsx";

const task = (plannedStart: string | null): Task => ({
  id: "afcab502-2199-43fd-b9d3-c8b556c6f25b",
  title: "Quarterly report",
  notes: "",
  status: "open",
  revision: 1,
  createdAt: "2026-08-06T12:00:00.000Z",
  updatedAt: "2026-08-06T12:00:00.000Z",
  completedAt: null,
  deletedAt: null,
  plannedStart,
  estimateMinutes: 30,
  projectId: null,
  tagIds: [],
});

const render = (plannedStart: string | null, available = true) =>
  renderToStaticMarkup(
    <TimeBlockForm
      task={task(plannedStart)}
      calendars={[
        {
          id: "work",
          providerId: "provider",
          href: "/work",
          displayName: "Work",
          supportsEvents: true,
          supportsTodos: false,
        },
      ]}
      busy={false}
      available={available}
      onSubmit={async () => await Promise.resolve()}
      onRemove={async () => await Promise.resolve()}
    />,
  );

describe("TimeBlockForm", () => {
  it("renders schedule, move, remove, and offline contracts", () => {
    expect(render(null)).toContain("Schedule");
    const scheduled = render("2026-08-10T15:00:00.000Z");
    expect(scheduled).toContain("Move calendar block");
    expect(scheduled).toContain("Remove calendar block");
    const offline = render(null, false);
    expect(offline).toContain("Reconnect to change calendar blocks");
    expect(offline).toContain("disabled");
  });
});
