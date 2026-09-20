import { useLayoutEffect, useMemo, useState } from "react";
import type { PlannerResponse } from "@suite/contracts";
import { getPlanner } from "./api.ts";
import {
  createPlannerLoader,
  type PlannerLoadState,
} from "./planner-loader.ts";

export const usePlannerLoader = (
  sessionKey: string | null,
  publish: (planner: PlannerResponse) => void,
  messageFor: (error: unknown) => string,
) => {
  const [status, setStatus] = useState<PlannerLoadState>({
    loading: false,
    error: null,
  });
  const controller = useMemo(
    () =>
      createPlannerLoader({
        request: ({ from, to }) => getPlanner(from, to),
        publish,
        status: setStatus,
        messageFor,
      }),
    [sessionKey, publish, messageFor],
  );
  useLayoutEffect(() => {
    setStatus({ loading: false, error: null });
    if (sessionKey === null) controller.dispose();
    else controller.activate();
    return () => controller.dispose();
  }, [controller, sessionKey]);
  return {
    loadPlanner: controller.load,
    plannerLoading: status.loading,
    plannerError: status.error,
  };
};
