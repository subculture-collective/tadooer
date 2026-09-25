import { expect, it } from "vitest";
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  historyLikePattern,
  historySortKey,
  validateTaskArchive,
} from "./task-archive.ts";

it("archives and restores only whole top-level families", () => {
  expect(
    validateTaskArchive({ task: {}, action: "archive", blocked: false }),
  ).toBeNull();
  expect(
    validateTaskArchive({
      task: { parentId: "parent" },
      action: "archive",
      blocked: false,
    }),
  ).toBe("task_is_child");
  expect(
    validateTaskArchive({ task: {}, action: "archive", blocked: true }),
  ).toBe("task_blocked");
  expect(
    validateTaskArchive({ task: {}, action: "restore", blocked: false }),
  ).toBe("task_not_archived");
  expect(
    validateTaskArchive({
      task: { archivedAt: "2026-09-24T00:00:00.000Z" },
      action: "restore",
      blocked: true,
    }),
  ).toBeNull();
});

it("round-trips opaque history cursors and rejects anything else", () => {
  const cursor = { sortKey: "2026-09-24T00:00:00.000Z", id: "task-id" };
  const encoded = encodeHistoryCursor(cursor);
  expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(decodeHistoryCursor(encoded)).toEqual(cursor);
  for (const invalid of [
    "",
    "not valid!",
    "e30",
    encodeHistoryCursor({ sortKey: "x", id: "" }),
  ])
    expect(decodeHistoryCursor(invalid)).toBeUndefined();
});

it("sorts by completion, then archive time, and escapes search wildcards", () => {
  expect(
    historySortKey({
      completedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: "2026-09-24T00:00:00.000Z",
    }),
  ).toBe("2026-01-01T00:00:00.000Z");
  expect(
    historySortKey({
      completedAt: null,
      archivedAt: "2026-09-24T00:00:00.000Z",
    }),
  ).toBe("2026-09-24T00:00:00.000Z");
  expect(historyLikePattern(" 50%_off\\ ")).toBe("%50\\%\\_off\\\\%");
});
