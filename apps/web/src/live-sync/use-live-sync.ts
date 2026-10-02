import { useEffect, useRef, useState } from "react";
import { openLiveSyncStream } from "../api.ts";
import type { LiveSyncController, LiveSyncHandlers } from "./controller.ts";
import type { LiveSyncStatus } from "./status.ts";
import { liveViewRegistry } from "./views.ts";

export type LiveSyncAppHandlers = Pick<
  LiveSyncHandlers,
  "identity" | "sync" | "reloadLocal"
>;

/**
 * Runs live sync while a session is signed in. `sessionKey` is null when
 * signed out or while the session needs recovery, which stops the stream and
 * leaves the leader election; a new key (the next sign-in) starts it again.
 * The handlers may change on every render; the latest ones are used.
 */
export const useLiveSync = (
  controller: LiveSyncController,
  sessionKey: string | null,
  handlers: LiveSyncAppHandlers,
): LiveSyncStatus => {
  const [status, setStatus] = useState<LiveSyncStatus>("paused");
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    if (sessionKey === null) return;
    controller.start({
      identity: () => latest.current.identity(),
      sync: (trigger) => latest.current.sync(trigger),
      reloadLocal: () => latest.current.reloadLocal(),
      openStream: openLiveSyncStream,
      refetch: (families, source) => {
        liveViewRegistry.refetch(families, source);
      },
      onStatus: setStatus,
    });
    return () => {
      controller.stop();
      setStatus("paused");
    };
  }, [controller, sessionKey]);
  return status;
};
