import { describe, expect, it } from "vitest";
import {
  evaluateChoicePool,
  suggestChoicePool,
  validateChoicePoolSelection,
  type ChoicePoolItemState,
  type ChoicePoolSelectionState,
} from "./choice-pool.ts";

const items: readonly ChoicePoolItemState[] = [
  { id: "a", position: 0, archived: false },
  { id: "b", position: 1, archived: false },
  { id: "c", position: 2, archived: false },
];

describe("choice pool policy", () => {
  it("opens cooldown eligibility at the exact logical boundary", () => {
    const config = {
      policy: "cooldown" as const,
      pickCount: 1,
      cooldownSeconds: 300,
    };
    const history = [
      { itemId: "a", selectedAt: "2026-08-07T12:00:00.000Z", cycle: 1 },
    ];
    expect(
      evaluateChoicePool(config, items, history, "2026-08-07T12:04:59.999Z")
        .items[0],
    ).toMatchObject({
      eligible: false,
      reason: "cooldown",
      eligibleAt: "2026-08-07T12:05:00.000Z",
    });
    expect(
      evaluateChoicePool(config, items, history, "2026-08-07T12:05:00.000Z")
        .items[0],
    ).toMatchObject({ eligible: true, reason: "eligible" });
  });

  it("cycles without replacement and admits a newly active item", () => {
    const config = {
      policy: "cycle" as const,
      pickCount: 1,
      cooldownSeconds: null,
    };
    const history: readonly ChoicePoolSelectionState[] = [
      { itemId: "a", selectedAt: "2026-08-07T10:00:00.000Z", cycle: 1 },
      { itemId: "b", selectedAt: "2026-08-07T11:00:00.000Z", cycle: 1 },
    ];
    expect(
      suggestChoicePool(config, items, history, "2026-08-07T12:00:00.000Z"),
    ).toMatchObject({ selectedItemIds: ["c"], cycle: 1 });
    const exhausted = [
      ...history,
      { itemId: "c", selectedAt: "2026-08-07T12:00:00.000Z", cycle: 1 },
    ];
    expect(
      suggestChoicePool(config, items, exhausted, "2026-08-07T13:00:00.000Z"),
    ).toMatchObject({ selectedItemIds: ["a"], cycle: 2 });
    const withNewItem = [...items, { id: "d", position: 3, archived: false }];
    expect(
      suggestChoicePool(
        config,
        withNewItem,
        history,
        "2026-08-07T12:00:00.000Z",
      ),
    ).toMatchObject({ selectedItemIds: ["c"], cycle: 1 });
  });

  it("retires one-shot items and permits a recorded override", () => {
    const config = {
      policy: "one_shot" as const,
      pickCount: 1,
      cooldownSeconds: null,
    };
    const history = [
      { itemId: "a", selectedAt: "2026-08-07T12:00:00.000Z", cycle: 1 },
    ];
    expect(
      evaluateChoicePool(config, items, history, "2026-08-07T13:00:00.000Z")
        .items[0],
    ).toMatchObject({ eligible: false, reason: "one_shot_selected" });
    expect(
      validateChoicePoolSelection(
        config,
        items,
        history,
        "2026-08-07T13:00:00.000Z",
        ["a"],
        false,
      ),
    ).toMatchObject({ valid: false, reason: "one_shot_selected" });
    expect(
      validateChoicePoolSelection(
        config,
        items,
        history,
        "2026-08-07T13:00:00.000Z",
        ["a"],
        true,
      ),
    ).toMatchObject({ valid: true, reason: null });
  });

  it("never suggests duplicates and explains every item across generated histories", () => {
    for (let seed = 0; seed < 100; seed += 1) {
      const generatedItems = Array.from(
        { length: 3 + (seed % 7) },
        (_, index) => ({
          id: `item-${index}`,
          position: index,
          archived: index === seed % 11,
        }),
      );
      const history = Array.from({ length: seed % 13 }, (_, index) => ({
        itemId: `item-${index % generatedItems.length}`,
        selectedAt: new Date(Date.UTC(2026, 7, 1, index)).toISOString(),
        cycle: 1 + Math.floor(index / generatedItems.length),
      }));
      const suggestion = suggestChoicePool(
        {
          policy: "none",
          pickCount: Math.min(
            3,
            generatedItems.filter(({ archived }) => !archived).length,
          ),
          cooldownSeconds: null,
        },
        generatedItems,
        history,
        "2026-08-08T00:00:00.000Z",
      );
      expect(new Set(suggestion.selectedItemIds).size).toBe(
        suggestion.selectedItemIds.length,
      );
      expect(suggestion.eligibility).toHaveLength(generatedItems.length);
      expect(
        suggestion.eligibility.every(({ reason }) => reason.length > 0),
      ).toBe(true);
    }
  });
});
