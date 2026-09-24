import type { ReactNode } from "react";
import type { WorkspaceRoute } from "@/app/routes";
import { SidebarNav } from "./SidebarNav.tsx";
import { TopBar } from "./TopBar.tsx";
import { Badge } from "@/components/ui/badge";

interface AppShellProps {
  readonly route: WorkspaceRoute;
  readonly onNavigate: (route: WorkspaceRoute) => void;
  readonly syncStatus: "online" | "offline" | "syncing" | undefined;
  readonly conflictCount: number | undefined;
  readonly baikalConnected: boolean;
  readonly formError: string | null;
  readonly onSignOut: () => void;
  readonly commandTrigger?: ReactNode;
  readonly children: ReactNode;
}

export const AppShell = ({
  route,
  onNavigate,
  syncStatus,
  conflictCount,
  baikalConnected,
  formError,
  onSignOut,
  commandTrigger,
  children,
}: AppShellProps) => (
  <div className="workspace">
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="brand-dot" />
        Productivity Suite
      </div>
      <SidebarNav route={route} onNavigate={onNavigate} />
      <div className="sidebar-status">
        <Badge variant="outline" className="status-row">
          <span
            className={`status-dot ${syncStatus === "online" || syncStatus === "syncing" ? "online" : "offline"}`}
          />
          Task sync: {syncStatus ?? "offline"}
        </Badge>
        {conflictCount !== undefined && conflictCount > 0 && (
          <Badge variant="destructive" className="status-row">
            <span className="status-dot error" />
            Conflicts: {conflictCount}
          </Badge>
        )}
        <Badge variant="secondary" className="status-row status-row--quiet">
          {baikalConnected ? "Baikal verified" : "Baikal disconnected"}
        </Badge>
      </div>
    </aside>
    <TopBar
      route={route}
      formError={formError}
      onSignOut={onSignOut}
      commandTrigger={commandTrigger}
    />
    <main className="main">{children}</main>
  </div>
);
