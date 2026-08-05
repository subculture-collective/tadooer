import { useEffect, useState } from "react";
import { loadFoundationStatus, type FoundationStatus } from "./api.ts";

export type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly status: FoundationStatus }
  | { readonly kind: "error"; readonly message: string };

export interface AppProps {
  readonly initialState?: LoadState;
  readonly loadStatus?: () => Promise<FoundationStatus>;
}

const statusLabel = (state: LoadState): string => {
  if (state.kind === "loading") return "Checking foundation";
  if (state.kind === "error") return "Foundation unavailable";
  return state.status.readiness.status === "ok"
    ? "Foundation ready"
    : "Foundation not ready";
};

export const App = ({
  initialState,
  loadStatus = loadFoundationStatus,
}: AppProps) => {
  const [state, setState] = useState<LoadState>(
    initialState ?? { kind: "loading" },
  );

  useEffect(() => {
    if (initialState !== undefined) return;

    let active = true;
    void loadStatus()
      .then((status) => {
        if (active) setState({ kind: "ready", status });
      })
      .catch((error: unknown) => {
        if (active) {
          setState({
            kind: "error",
            message:
              error instanceof Error
                ? error.message
                : "Unknown readiness error",
          });
        }
      });

    return () => {
      active = false;
    };
  }, [initialState, loadStatus]);

  return (
    <main className="shell">
      <section className="hero" aria-labelledby="suite-title">
        <p className="eyebrow">Private · self-hosted · calm by default</p>
        <h1 id="suite-title">Productivity Suite</h1>
        <p className="lede">
          The new foundation is running. Tasks, calendar planning, focus
          handoff, and safe automation will arrive as tested vertical slices.
        </p>

        <div
          className={`status status--${state.kind}`}
          role="status"
          aria-live="polite"
        >
          <span className="status__light" aria-hidden="true" />
          <div>
            <strong>{statusLabel(state)}</strong>
            {state.kind === "loading" && <p>Contacting the Suite API…</p>}
            {state.kind === "error" && <p>{state.message}</p>}
            {state.kind === "ready" && (
              <p>
                SQLite and {state.status.readiness.migrationCount} migration
                {state.status.readiness.migrationCount === 1 ? "" : "s"}{" "}
                verified.
              </p>
            )}
          </div>
        </div>

        {state.kind === "ready" && (
          <dl className="facts">
            <div>
              <dt>Instance</dt>
              <dd>
                {state.status.readiness.instanceId?.slice(0, 8) ??
                  "Unavailable"}
              </dd>
            </div>
            <div>
              <dt>Version</dt>
              <dd>{state.status.build.version}</dd>
            </div>
            <div>
              <dt>Revision</dt>
              <dd>{state.status.build.revision.slice(0, 12)}</dd>
            </div>
          </dl>
        )}
      </section>

      <aside className="boundary" aria-label="Foundation boundaries">
        <p className="boundary__number">Phase 0A</p>
        <h2>What exists today</h2>
        <ul>
          <li>One React web shell and same-origin API</li>
          <li>Persistent, migration-managed SQLite storage</li>
          <li>Replaceable CalDAV boundary with bundled Baïkal</li>
          <li>Health, readiness, and build evidence</li>
        </ul>
        <p className="boundary__note">
          No task or calendar product behavior is claimed by this foundation
          screen.
        </p>
      </aside>
    </main>
  );
};
