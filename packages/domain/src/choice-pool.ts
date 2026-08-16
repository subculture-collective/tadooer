export type ChoicePoolPolicy = "none" | "cooldown" | "cycle" | "one_shot";

export interface ChoicePoolPolicyConfig {
  readonly policy: ChoicePoolPolicy;
  readonly pickCount: number;
  readonly cooldownSeconds: number | null;
}

export interface ChoicePoolItemState {
  readonly id: string;
  readonly position: number;
  readonly archived: boolean;
}

export interface ChoicePoolSelectionState {
  readonly itemId: string;
  readonly selectedAt: string;
  readonly cycle: number;
}

export type ChoicePoolEligibilityReason =
  "eligible" | "archived" | "cooldown" | "cycle_selected" | "one_shot_selected";

export interface ChoicePoolItemEligibility {
  readonly itemId: string;
  readonly eligible: boolean;
  readonly reason: ChoicePoolEligibilityReason;
  readonly eligibleAt: string | null;
  readonly lastSelectedAt: string | null;
}

export interface ChoicePoolSuggestion {
  readonly selectedItemIds: readonly string[];
  readonly cycle: number;
  readonly eligibility: readonly ChoicePoolItemEligibility[];
}

const timestamp = (value: string): number => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new Error(`Invalid logical time: ${value}`);
  return parsed;
};

const activeCycle = (
  items: readonly ChoicePoolItemState[],
  history: readonly ChoicePoolSelectionState[],
): number => {
  const activeIds = new Set(
    items.filter(({ archived }) => !archived).map(({ id }) => id),
  );
  const latestCycle = history.reduce(
    (maximum, event) => Math.max(maximum, event.cycle),
    1,
  );
  const selected = new Set(
    history
      .filter(
        ({ cycle, itemId }) => cycle === latestCycle && activeIds.has(itemId),
      )
      .map(({ itemId }) => itemId),
  );
  return activeIds.size > 0 && selected.size >= activeIds.size
    ? latestCycle + 1
    : latestCycle;
};

export const evaluateChoicePool = (
  config: ChoicePoolPolicyConfig,
  items: readonly ChoicePoolItemState[],
  history: readonly ChoicePoolSelectionState[],
  logicalTime: string,
): {
  readonly cycle: number;
  readonly items: readonly ChoicePoolItemEligibility[];
} => {
  if (!Number.isInteger(config.pickCount) || config.pickCount < 1)
    throw new Error("Choice pool pick count must be positive");
  if (
    config.policy === "cooldown" &&
    (!Number.isInteger(config.cooldownSeconds) ||
      (config.cooldownSeconds ?? 0) < 1)
  )
    throw new Error("Cooldown policy requires positive cooldown seconds");
  const now = timestamp(logicalTime);
  const cycle = activeCycle(items, history);
  const latestByItem = new Map<string, ChoicePoolSelectionState>();
  for (const event of history) {
    const existing = latestByItem.get(event.itemId);
    if (
      existing === undefined ||
      timestamp(event.selectedAt) > timestamp(existing.selectedAt)
    )
      latestByItem.set(event.itemId, event);
  }
  return {
    cycle,
    items: items.map((item): ChoicePoolItemEligibility => {
      const latest = latestByItem.get(item.id);
      const lastSelectedAt = latest?.selectedAt ?? null;
      if (item.archived)
        return {
          itemId: item.id,
          eligible: false,
          reason: "archived",
          eligibleAt: null,
          lastSelectedAt,
        };
      if (config.policy === "one_shot" && latest !== undefined)
        return {
          itemId: item.id,
          eligible: false,
          reason: "one_shot_selected",
          eligibleAt: null,
          lastSelectedAt,
        };
      if (
        config.policy === "cycle" &&
        history.some(
          ({ itemId, cycle: eventCycle }) =>
            itemId === item.id && eventCycle === cycle,
        )
      )
        return {
          itemId: item.id,
          eligible: false,
          reason: "cycle_selected",
          eligibleAt: null,
          lastSelectedAt,
        };
      if (config.policy === "cooldown" && latest !== undefined) {
        const eligibleAt =
          timestamp(latest.selectedAt) + (config.cooldownSeconds ?? 0) * 1_000;
        if (now < eligibleAt)
          return {
            itemId: item.id,
            eligible: false,
            reason: "cooldown",
            eligibleAt: new Date(eligibleAt).toISOString(),
            lastSelectedAt,
          };
      }
      return {
        itemId: item.id,
        eligible: true,
        reason: "eligible",
        eligibleAt: null,
        lastSelectedAt,
      };
    }),
  };
};

export const suggestChoicePool = (
  config: ChoicePoolPolicyConfig,
  items: readonly ChoicePoolItemState[],
  history: readonly ChoicePoolSelectionState[],
  logicalTime: string,
): ChoicePoolSuggestion => {
  const evaluation = evaluateChoicePool(config, items, history, logicalTime);
  const itemById = new Map(items.map((item) => [item.id, item]));
  const candidates = evaluation.items
    .filter(({ eligible }) => eligible)
    .sort((left, right) => {
      const leftTime =
        left.lastSelectedAt === null
          ? Number.NEGATIVE_INFINITY
          : timestamp(left.lastSelectedAt);
      const rightTime =
        right.lastSelectedAt === null
          ? Number.NEGATIVE_INFINITY
          : timestamp(right.lastSelectedAt);
      return (
        leftTime - rightTime ||
        (itemById.get(left.itemId)?.position ?? 0) -
          (itemById.get(right.itemId)?.position ?? 0) ||
        left.itemId.localeCompare(right.itemId)
      );
    });
  return {
    selectedItemIds: candidates
      .slice(0, config.pickCount)
      .map(({ itemId }) => itemId),
    cycle: evaluation.cycle,
    eligibility: evaluation.items,
  };
};

export const validateChoicePoolSelection = (
  config: ChoicePoolPolicyConfig,
  items: readonly ChoicePoolItemState[],
  history: readonly ChoicePoolSelectionState[],
  logicalTime: string,
  selectedItemIds: readonly string[],
  override: boolean,
): {
  readonly valid: boolean;
  readonly cycle: number;
  readonly reason: string | null;
} => {
  if (
    selectedItemIds.length !== config.pickCount ||
    new Set(selectedItemIds).size !== selectedItemIds.length
  )
    return { valid: false, cycle: 1, reason: "pick_count" };
  const evaluation = evaluateChoicePool(config, items, history, logicalTime);
  const eligibility = new Map(
    evaluation.items.map((item) => [item.itemId, item]),
  );
  for (const itemId of selectedItemIds) {
    const item = eligibility.get(itemId);
    if (item === undefined || item.reason === "archived")
      return {
        valid: false,
        cycle: evaluation.cycle,
        reason: "item_unavailable",
      };
    if (!item.eligible && !override)
      return { valid: false, cycle: evaluation.cycle, reason: item.reason };
  }
  return { valid: true, cycle: evaluation.cycle, reason: null };
};
