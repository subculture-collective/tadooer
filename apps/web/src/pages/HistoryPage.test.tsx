import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ApiRequestError,
  type Task,
  type TaskHistoryEntry,
} from "@suite/contracts";
import {
  emptyHistory,
  loadMoreHistory,
  restoreFromHistory,
  searchHistory,
  type HistoryApi,
} from "./history-controller.ts";
import { HistoryList, HistoryPage } from "./HistoryPage.tsx";

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id.slice(-1)}`,
  notes: "",
  status: "completed",
  revision: 3,
  createdAt: "2025-12-01T00:00:00.000Z",
  updatedAt: "2026-09-24T00:00:00.000Z",
  completedAt: "2026-01-02T00:00:00.000Z",
  deletedAt: null,
  plannedStart: null,
  estimateMinutes: null,
  projectId: null,
  tagIds: [],
  parentId: null,
  childPosition: null,
  archivedAt: "2026-09-24T00:00:00.000Z",
  ...extra,
});
const parentId = "00000000-0000-4000-8000-000000000001";
const entry: TaskHistoryEntry = {
  task: task(parentId, {
    title: "Quarterly report",
    projectId: "00000000-0000-4000-8000-0000000000aa",
  }),
  provenance: {
    source: "super_productivity",
    sourceStore: "archiveOld",
    review: [],
    historicalReferences: [
      { kind: "tag", sourceId: "gone-tag", reason: "missing_from_export" },
    ],
  },
  children: [
    {
      task: task("00000000-0000-4000-8000-000000000002", {
        title: "Untitled archived task",
        parentId,
        childPosition: 1024,
      }),
      provenance: {
        source: "super_productivity",
        sourceStore: "archiveOld",
        review: ["blank_title"],
        historicalReferences: [],
      },
    },
  ],
};
const state = {
  ...emptyHistory,
  entries: [entry],
  total: 3,
  nextCursor: "abc",
};

describe("History view", () => {
  it("shows archived families with dates, provenance, review flags and restore", () => {
    const html = renderToStaticMarkup(
      <HistoryList
        state={state}
        online
        busy={false}
        timeZone="UTC"
        projects={[
          { id: "00000000-0000-4000-8000-0000000000aa", title: "Work" },
        ]}
        onRestore={vi.fn()}
        onLoadMore={vi.fn()}
      />,
    );
    expect(html).toContain("Showing 1 of 3 archived tasks");
    expect(html).toContain("Quarterly report");
    expect(html).toContain("Created Dec 1, 2025 · completed Jan 2, 2026");
    expect(html).toContain("· Work");
    expect(html).toContain("Imported from Super Productivity (archiveOld)");
    expect(html).toContain("Tag gone-tag: not in the source export");
    expect(html).toContain("Needs review");
    expect(html).toContain("Imported without a title");
    expect(html).toContain("Child tasks of Quarterly report");
    expect(html).toContain("Restore to Tasks");
    expect(html).toContain("Show more");
  });

  it("explains empty results and disables actions offline", () => {
    expect(
      renderToStaticMarkup(
        <HistoryList
          state={{ ...emptyHistory, query: "zzz" }}
          online
          busy={false}
          timeZone="UTC"
          projects={[]}
          onRestore={vi.fn()}
          onLoadMore={vi.fn()}
        />,
      ),
    ).toContain("No archived tasks match.");
    const offline = renderToStaticMarkup(
      <HistoryPage
        csrfToken="csrf"
        online={false}
        onRestored={vi.fn()}
        initialState={state}
      />,
    );
    expect(offline).toContain("History needs a connection");
    expect(offline).toContain('disabled="">Restore to Tasks');
  });
});

describe("history controller", () => {
  const api = (overrides: Partial<HistoryApi> = {}): HistoryApi => ({
    getTaskHistory: vi.fn(() =>
      Promise.resolve({ entries: [entry], total: 1, nextCursor: null }),
    ),
    unarchiveTask: vi.fn(() =>
      Promise.resolve({
        archive: {
          action: "restored" as const,
          task: { ...entry.task, archivedAt: null, revision: 4 },
          children: entry.children.map((child) => child.task),
        },
      }),
    ),
    ...overrides,
  });

  it("searches, pages without duplicates and restores a whole family", async () => {
    const client = api();
    const searched = await searchHistory(client, "report");
    expect(client.getTaskHistory).toHaveBeenCalledWith({ query: "report" });
    expect(searched).toMatchObject({ query: "report", total: 1 });
    const more = await loadMoreHistory(client, {
      ...searched,
      nextCursor: "next",
    });
    expect(client.getTaskHistory).toHaveBeenLastCalledWith({
      query: "report",
      cursor: "next",
    });
    expect(more.entries).toHaveLength(1);
    const restored = await restoreFromHistory(client, searched, entry, "csrf");
    expect(client.unarchiveTask).toHaveBeenCalledWith(parentId, 3, "csrf");
    expect(restored.restored).toBe(true);
    expect(restored.state.entries).toEqual([]);
    expect(restored.state.notice).toBe(
      'Restored "Quarterly report" with 1 child task to Tasks.',
    );
  });

  it("keeps the entry and explains a stale restore", async () => {
    const client = api({
      unarchiveTask: vi.fn(() =>
        Promise.reject(
          new ApiRequestError(412, "TASK_REVISION_CONFLICT", "changed"),
        ),
      ),
    });
    const result = await restoreFromHistory(client, state, entry, "csrf");
    expect(result.restored).toBe(false);
    expect(result.state.entries).toHaveLength(1);
    expect(result.state.error).toContain("changed since the list loaded");
  });
});
