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
      <button className="btn-ghost" type="button" onClick={onSignOut}>
        Sign out
      </button>
    </div>
    {formError !== null && (
      <span role="alert" className="message message-error">
        {formError}
      </span>
    )}
  </header>
);
