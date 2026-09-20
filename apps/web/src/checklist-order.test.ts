import { describe, expect, it } from "vitest";
import type { Subtask } from "@suite/contracts";
import { moveChecklistItem } from "./checklist-order.ts";

const subtask = (id: string, position: number): Subtask => ({
  id,
  taskId: "afcab502-2199-43fd-b9d3-c8b556c6f25b",
  title: id,
  completed: false,
  position,
  revision: 1,
  createdAt: "2026-08-21T12:00:00.000Z",
  updatedAt: "2026-08-21T12:00:00.000Z",
});

describe("moveChecklistItem", () => {
  const items = [
    subtask("first", 0),
    subtask("second", 1),
    subtask("third", 2),
  ];

  it("moves an item to the adjacent ordered slot", () => {
    expect(
      moveChecklistItem(items, "second", "up")?.map(({ id }) => id),
    ).toEqual(["second", "first", "third"]);
    expect(
      moveChecklistItem(items, "second", "down")?.map(({ id }) => id),
    ).toEqual(["first", "third", "second"]);
  });

  it("does not produce an order outside the list", () => {
    expect(moveChecklistItem(items, "first", "up")).toBeUndefined();
    expect(moveChecklistItem(items, "third", "down")).toBeUndefined();
  });
});
