import type { ReactNode } from "react";
import type { WorkspaceRoute } from "@/app/routes";
import { SidebarNav } from "./SidebarNav.tsx";
import { TopBar } from "./TopBar.tsx";
import { Badge } from "@/components/ui/badge";
import {
  liveSyncStatusDescription,
  liveSyncStatusDot,
  liveSyncStatusLabel,
  type LiveSyncStatus,
} from "@/live-sync/status";

interface AppShellProps {
  readonly route: WorkspaceRoute;
  readonly onNavigate: (route: WorkspaceRoute) => void;
  readonly syncStatus: "online" | "offline" | "syncing" | undefined;
  /** ADR 0045 live sync state; omitted where live sync is not running. */
  readonly liveStatus?: LiveSyncStatus | undefined;
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
  liveStatus,
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
        Tadooer
      </div>
      <SidebarNav route={route} onNavigate={onNavigate} />
      <div className="sidebar-status">
        <Badge variant="outline" className="status-row">
          <span
            className={`status-dot ${syncStatus === "online" || syncStatus === "syncing" ? "online" : "offline"}`}
          />
          Task sync: {syncStatus ?? "offline"}
        </Badge>
        {liveStatus !== undefined && (
          <Badge
            variant="outline"
            className="status-row"
            role="status"
            title={liveSyncStatusDescription(liveStatus)}
          >
            <span
              aria-hidden="true"
              className={`status-dot ${liveSyncStatusDot(liveStatus)}`}
            />
            Live updates: {liveSyncStatusLabel(liveStatus)}
            <span className="sr-only">
              . {liveSyncStatusDescription(liveStatus)}
            </span>
          </Badge>
        )}
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
