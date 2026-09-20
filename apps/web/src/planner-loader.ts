import type { PlannerResponse } from "@suite/contracts";

export interface PlannerWindow {
  readonly from: string;
  readonly to: string;
}
export interface PlannerLoadState {
  readonly loading: boolean;
  readonly error: string | null;
}

// A controller belongs to one authenticated session generation. Cancellation is
// logical: the HTTP request may finish, but obsolete results cannot publish.
export const createPlannerLoader = (options: {
  readonly request: (window: PlannerWindow) => Promise<PlannerResponse>;
  readonly publish: (planner: PlannerResponse) => void;
  readonly status: (state: PlannerLoadState) => void;
  readonly messageFor: (error: unknown) => string;
}) => {
  let generation = 0;
  let active = true;
  const isCurrent = (current: number): boolean =>
    active && current === generation;
  return {
    activate() {
      active = true;
    },
    dispose() {
      active = false;
      generation++;
    },
    load: async (window: PlannerWindow): Promise<void> => {
      if (!active) return;
      const current = ++generation;
      options.status({ loading: true, error: null });
      try {
        const planner = await options.request(window);
        if (!isCurrent(current)) return;
        options.publish(planner);
        options.status({ loading: false, error: null });
      } catch (error: unknown) {
        if (isCurrent(current))
          options.status({ loading: false, error: options.messageFor(error) });
      }
    },
  };
};
