import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HabitsPage } from "./HabitsPage.tsx";

describe("Habits workspace", () => {
  it("shows canonical completions and disables mutations offline", () => {
    const now = "2026-09-19T12:00:00.000Z";
    const html = renderToStaticMarkup(
      <HabitsPage
        online={false}
        pending={false}
        timeZone="UTC"
        now={now}
        onCommand={async () => {
          await Promise.resolve();
        }}
        library={{
          habits: [
            {
              id: "10000000-0000-4000-8000-000000000001",
              ownerId: "10000000-0000-4000-8000-000000000002",
              title: "Walk",
              cadence: { kind: "daily" },
              timeZone: "UTC",
              startedOn: "2026-09-18",
              revision: 1,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
            },
          ],
          occurrences: [
            {
              id: "10000000-0000-4000-8000-000000000003",
              habitId: "10000000-0000-4000-8000-000000000001",
              periodKey: "2026-09-19",
              completedAt: now,
              createdAt: now,
            },
          ],
        }}
      />,
    );
    expect(html).toContain("Connect to record or change habits");
    expect(html).toContain("Completed today");
    expect(html).toContain("Current streak: 1");
    expect(html).toContain("Longest streak: 1");
    expect(html).toContain('<fieldset disabled=""');
    expect(html).toContain('disabled="">Completed today');
    expect(html).toContain("Rename Walk");
  });
});
