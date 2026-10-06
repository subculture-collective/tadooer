import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { SessionResponse } from "@suite/contracts";
import {
  subscribeSessionFailure,
  type SessionFailure,
} from "./session-recovery.ts";

const sessionKeyFor = (session: SessionResponse | null): string | null =>
  session === null ? null : `${session.owner.id}:${session.csrfToken}`;

/** Owns the session-failure subscription for one authenticated generation. */
export const useSessionRecovery = (
  session: SessionResponse | null,
  onRecovered: (session: SessionResponse) => void,
) => {
  const sessionKey = sessionKeyFor(session);
  const currentSessionKey = useRef(sessionKey);
  currentSessionKey.current = sessionKey;
  const [failure, setFailure] = useState<SessionFailure | null>(null);

  useLayoutEffect(() => {
    setFailure(null);
    if (sessionKey === null) return;
    return subscribeSessionFailure((nextFailure) => {
      if (currentSessionKey.current === sessionKey) setFailure(nextFailure);
    });
  }, [sessionKey]);

  const recover = useCallback(
    (recovered: SessionResponse): void => {
      // A recovery request from a replaced or signed-out session must not
      // publish over the newer session generation.
      if (sessionKey === null || currentSessionKey.current !== sessionKey)
        return;
      onRecovered(recovered);
      setFailure(null);
    },
    [onRecovered, sessionKey],
  );

  const reportFailure = useCallback((nextFailure: SessionFailure): void => {
    if (currentSessionKey.current !== null) setFailure(nextFailure);
  }, []);

  return { failure, recover, reportFailure };
};
