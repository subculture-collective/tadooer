import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  defaultApplicationPreferences,
  type ApplicationPreferenceSnapshot,
  type ApplicationPreferences,
} from "@suite/contracts";
import { ApiRequestError } from "@suite/contracts";
import {
  getApplicationPreferences,
  updateApplicationPreferences,
} from "./api.ts";
import { applyTheme, readStoredTheme, watchSystemTheme } from "./theme.ts";

/**
 * Application preferences in the browser (ADR 0030). The record is loaded
 * once per authenticated session and shared through context, so pages read
 * capture defaults, Markdown rendering and shortcut bindings without prop
 * drilling. Saves carry the revision that was read; a 412 reloads the record
 * and reports the conflict instead of overwriting another client's save.
 */
export interface ApplicationPreferencesState {
  readonly snapshot: ApplicationPreferenceSnapshot;
  /** False until the server record was read; defaults apply meanwhile. */
  readonly loaded: boolean;
  readonly error: string | null;
  readonly save: (preferences: ApplicationPreferences) => Promise<boolean>;
  readonly reload: () => Promise<void>;
}

const defaultSnapshot: ApplicationPreferenceSnapshot = {
  revision: 0,
  preferences: { ...defaultApplicationPreferences, theme: readStoredTheme() },
};

const noop = (): Promise<boolean> => Promise.resolve(false);
const noopReload = (): Promise<void> => Promise.resolve();

export const ApplicationPreferencesContext =
  createContext<ApplicationPreferencesState>({
    snapshot: defaultSnapshot,
    loaded: false,
    error: null,
    save: noop,
    reload: noopReload,
  });

export const useApplicationPreferences = (): ApplicationPreferencesState =>
  useContext(ApplicationPreferencesContext);

export const applicationPreferencesConflictMessage =
  "Application preferences changed elsewhere. They were reloaded; apply your change again.";

/**
 * Owns the record for one authenticated session. `csrfToken` is undefined
 * while signed out or offline, which keeps the defaults and disables saves.
 */
export const useApplicationPreferencesController = (
  csrfToken: string | undefined,
): ApplicationPreferencesState => {
  const [snapshot, setSnapshot] = useState(defaultSnapshot);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    if (csrfToken === undefined) return;
    try {
      setSnapshot(await getApplicationPreferences());
      setLoaded(true);
      setError(null);
    } catch (cause: unknown) {
      setError(
        cause instanceof ApiRequestError || cause instanceof Error
          ? cause.message
          : "Application preferences could not be loaded",
      );
    }
  }, [csrfToken]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (preferences: ApplicationPreferences): Promise<boolean> => {
      if (csrfToken === undefined) return false;
      try {
        setSnapshot(
          await updateApplicationPreferences(
            { expectedRevision: snapshot.revision, preferences },
            csrfToken,
          ),
        );
        setError(null);
        return true;
      } catch (cause: unknown) {
        if (cause instanceof ApiRequestError && cause.status === 412) {
          await reload();
          setError(applicationPreferencesConflictMessage);
        } else
          setError(
            cause instanceof Error
              ? cause.message
              : "Application preferences could not be saved",
          );
        return false;
      }
    },
    [csrfToken, reload, snapshot.revision],
  );

  const theme = snapshot.preferences.theme;
  useEffect(() => {
    applyTheme(theme);
    return watchSystemTheme(theme, () => applyTheme(theme));
  }, [theme]);

  return { snapshot, loaded, error, save, reload };
};

export const ApplicationPreferencesProvider = ({
  value,
  children,
}: {
  readonly value: ApplicationPreferencesState;
  readonly children: ReactNode;
}) => (
  <ApplicationPreferencesContext.Provider value={value}>
    {children}
  </ApplicationPreferencesContext.Provider>
);
