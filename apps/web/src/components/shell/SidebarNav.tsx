import {
  Cable,
  Repeat,
  CalendarDays,
  Clock,
  Gauge,
  History,
  Inbox,
  LayoutGrid,
  ListTodo,
  RotateCcw,
  Settings,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { routeLabel, workspaceRoutes, type WorkspaceRoute } from "@/app/routes";

const routeIcons: Readonly<Record<WorkspaceRoute, LucideIcon>> = {
  today: Sun,
  inbox: Inbox,
  planner: CalendarDays,
  tasks: ListTodo,
  boards: LayoutGrid,
  history: History,
  worklog: Clock,
  counters: Gauge,
  reuse: RotateCcw,
  habits: Repeat,
  connections: Cable,
  settings: Settings,
};

interface SidebarNavProps {
  readonly route: WorkspaceRoute;
  readonly onNavigate: (route: WorkspaceRoute) => void;
}

export const SidebarNav = ({ route, onNavigate }: SidebarNavProps) => (
  <nav className="sidebar-nav" aria-label="Workspace views">
    {workspaceRoutes.map((item) => {
      const Icon = routeIcons[item];

      return (
        <a
          key={item}
          href={`/${item}`}
          aria-current={route === item ? "page" : undefined}
          onClick={(event) => {
            event.preventDefault();
            onNavigate(item);
          }}
        >
          <Icon className="nav-icon" aria-hidden="true" />
          {routeLabel(item)}
        </a>
      );
    })}
  </nav>
);
