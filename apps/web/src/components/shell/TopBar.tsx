import type { ReactNode } from "react";
import { routeLabel, type WorkspaceRoute } from "@/app/routes";

interface TopBarProps {
  readonly route: WorkspaceRoute;
  readonly formError: string | null;
  readonly onSignOut: () => void;
  readonly commandTrigger?: ReactNode;
}

export const TopBar = ({
  route,
  formError,
  onSignOut,
  commandTrigger,
}: TopBarProps) => (
  <header className="topbar">
    <span className="topbar-breadcrumb">{routeLabel(route)}</span>
    <div className="topbar-actions">
      {commandTrigger}
      {formError !== null && (
        <span
          className="message message-error"
          style={{ padding: "0.25rem 0.5rem", fontSize: "var(--text-xs)" }}
        >
          {formError}
        </span>
      )}
      <button
        className="btn-ghost"
        type="button"
        onClick={onSignOut}
        style={{ fontSize: "var(--text-xs)" }}
      >
        Sign out
      </button>
    </div>
  </header>
);
