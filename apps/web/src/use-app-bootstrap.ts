import { useEffect } from "react";
import { getSetupStatus, resumeSession } from "./api.ts";
import {
  startAppBootstrap,
  type AppBootstrapOptions,
} from "./app-bootstrap.ts";

export const useAppBootstrap = ({
  enabled,
  loadAuthenticated,
  readOffline,
  publish,
  messageFor,
}: {
  readonly enabled: boolean;
} & Omit<AppBootstrapOptions, "setupStatus" | "resumeSession">): void => {
  useEffect(() => {
    if (!enabled) return;
    const startup = startAppBootstrap({
      setupStatus: getSetupStatus,
      resumeSession,
      loadAuthenticated,
      readOffline,
      publish,
      messageFor,
    });
    return startup.cancel;
  }, [enabled, loadAuthenticated, readOffline, publish, messageFor]);
};
