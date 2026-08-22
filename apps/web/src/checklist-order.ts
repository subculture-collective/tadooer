import type { Subtask } from "@suite/contracts";

export const moveChecklistItem = (
  items: readonly Subtask[],
  itemId: string,
  direction: "up" | "down",
): readonly Subtask[] | undefined => {
  const currentIndex = items.findIndex(({ id }) => id === itemId);
  if (currentIndex === -1) return undefined;
  const targetIndex = currentIndex + (direction === "up" ? -1 : 1);
  if (targetIndex < 0 || targetIndex >= items.length) return undefined;
  const reordered = [...items];
  const [item] = reordered.splice(currentIndex, 1);
  if (item === undefined) return undefined;
  reordered.splice(targetIndex, 0, item);
  return reordered;
};
