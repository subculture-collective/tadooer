import type { ReactNode } from "react";
import { routeLabel, type WorkspaceRoute } from "@/app/routes";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

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
      <Button variant="ghost" type="button" onClick={onSignOut}>
        Sign out
      </Button>
    </div>
    {formError !== null && (
      <Alert variant="destructive" className="message message-error">
        <AlertDescription>{formError}</AlertDescription>
      </Alert>
    )}
  </header>
);
