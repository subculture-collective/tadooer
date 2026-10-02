import type {
  BaikalStatusResponse,
  DayPlanResponse,
  GoogleConnectorStatusResponse,
  NotificationPreferences,
  NotificationStatusResponse,
  PlannerResponse,
  PlanningPreferences,
} from "@suite/contracts";
import {
  getBaikalStatus,
  getDayPlan,
  getGoogleStatus,
  getNotificationPreferences,
  getNotificationStatus,
  getPlanner,
  getPlanningPreferences,
} from "../api.ts";
import { useLiveRefetch } from "./views.ts";

/** The online reads the app shell keeps in its authenticated state. */
export interface LiveAppPatch {
  readonly baikal?: BaikalStatusResponse;
  readonly google?: GoogleConnectorStatusResponse;
  readonly planningPreferences?: PlanningPreferences;
  readonly dayPlan?: DayPlanResponse;
  readonly notificationPreferences?: NotificationPreferences;
  readonly notificationStatus?: NotificationStatusResponse;
  readonly planner?: PlannerResponse | null;
}

/**
 * Registers the app shell's own online reads for live sync `resources`
 * hints (ADR 0045). The shell loads these once per sign-in; each refetch
 * repeats the same read and merges it into the authenticated state. Pages
 * and panels that load their own data register themselves.
 */
export const useAppLiveViews = (input: {
  /** Signed in, session healthy and the browser online. */
  readonly enabled: boolean;
  /** A calendar connector is connected, so the shell has a planner window. */
  readonly calendarConnected: boolean;
  /** The Planner page is open and loads its own range. */
  readonly plannerPageOpen: boolean;
  readonly plannerWindow: () => { readonly from: string; readonly to: string };
  readonly patch: (patch: LiveAppPatch) => void;
  readonly cachePlanningPreferences: (
    preferences: PlanningPreferences,
  ) => Promise<void>;
  readonly refreshTemplates: () => Promise<void>;
  readonly refreshChoicePools: () => Promise<void>;
}): void => {
  const { enabled, patch } = input;
  const shellPlanner = async (): Promise<PlannerResponse> => {
    const window = input.plannerWindow();
    return getPlanner(window.from, window.to);
  };

  useLiveRefetch(
    "connectors",
    async () => {
      const [baikal, google] = await Promise.all([
        getBaikalStatus(),
        getGoogleStatus(),
      ]);
      patch({ baikal, google });
      // A connector that appeared or went away changes whether the shell
      // has a planner window at all.
      if (input.plannerPageOpen) return;
      patch({
        planner:
          baikal.connected || google.connected ? await shellPlanner() : null,
      });
    },
    enabled,
  );
  useLiveRefetch(
    "planner",
    async () => {
      patch({ planner: await shellPlanner() });
    },
    enabled && input.calendarConnected && !input.plannerPageOpen,
  );
  useLiveRefetch(
    "dayPlan",
    async () => {
      patch({ dayPlan: await getDayPlan() });
    },
    enabled,
  );
  useLiveRefetch(
    "planningPreferences",
    async () => {
      const planningPreferences = await getPlanningPreferences();
      patch({ planningPreferences });
      // Keep the offline copy current; a failed cache write is not an error
      // the owner needs to see for a background refresh.
      await input
        .cachePlanningPreferences(planningPreferences)
        .catch(() => undefined);
    },
    enabled,
  );
  useLiveRefetch(
    "notificationPreferences",
    async () => {
      const [notificationPreferences, notificationStatus] = await Promise.all([
        getNotificationPreferences(),
        getNotificationStatus(),
      ]);
      patch({ notificationPreferences, notificationStatus });
    },
    enabled,
  );
  useLiveRefetch("templates", input.refreshTemplates, enabled);
  useLiveRefetch("choicePools", input.refreshChoicePools, enabled);
};
