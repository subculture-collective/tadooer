export const workspaceRoutes = [
  "today",
  "inbox",
  "planner",
  "tasks",
  "boards",
  "history",
  "worklog",
  "counters",
  "reuse",
  "habits",
  "connections",
  "settings",
] as const;

export type WorkspaceRoute = (typeof workspaceRoutes)[number];

export const routeFromPath = (path: string): WorkspaceRoute => {
  const candidate = path.replace(/^\//, "").split("/")[0];
  return workspaceRoutes.find((route) => route === candidate) ?? "today";
};

export const routeLabel = (route: WorkspaceRoute): string =>
  route === "reuse" ? "Reuse" : route.charAt(0).toUpperCase() + route.slice(1);
