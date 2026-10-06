import {
  ApiRequestError,
  type Note,
  type SessionResponse,
} from "@suite/contracts";
import type { AppState } from "./app.tsx";

export interface AppBootstrapOptions {
  readonly setupStatus: () => Promise<{ readonly setupRequired: boolean }>;
  readonly resumeSession: () => Promise<SessionResponse>;
  readonly loadAuthenticated: (
    session: SessionResponse,
    isCurrent: () => boolean,
  ) => Promise<void>;
  readonly readOffline: () => Promise<
    (AppState & { readonly cachedNotes?: readonly Note[] }) | null
  >;
  readonly publish: (state: AppState, notes?: readonly Note[]) => void;
  readonly messageFor: (error: unknown) => string;
}

/** Owns one startup attempt. Cleanup invalidates all subsequent publications. */
export const startAppBootstrap = (options: AppBootstrapOptions) => {
  let cancelled = false;
  const isCurrent = () => !cancelled;
  const publish = (state: AppState, notes?: readonly Note[]) => {
    if (isCurrent()) options.publish(state, notes);
  };
  const done = (async () => {
    try {
      const { setupRequired } = await options.setupStatus();
      if (!isCurrent()) return;
      if (setupRequired) {
        publish({ kind: "setup" });
        return;
      }
      try {
        const session = await options.resumeSession();
        if (isCurrent()) await options.loadAuthenticated(session, isCurrent);
      } catch (error: unknown) {
        publish(
          error instanceof ApiRequestError && error.status === 401
            ? { kind: "login" }
            : { kind: "error", message: options.messageFor(error) },
        );
      }
    } catch (error: unknown) {
      if (!isCurrent()) return;
      try {
        const cached = await options.readOffline();
        if (cached === null)
          publish({ kind: "error", message: options.messageFor(error) });
        else {
          const { cachedNotes, ...state } = cached;
          publish(state, cachedNotes);
        }
      } catch {
        publish({ kind: "error", message: options.messageFor(error) });
      }
    }
  })();
  return {
    done,
    cancel: () => {
      cancelled = true;
    },
  };
};
