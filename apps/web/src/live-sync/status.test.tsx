import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppShell } from "../components/shell/AppShell.tsx";
import {
  liveSyncStatusDescription,
  liveSyncStatusDot,
  liveSyncStatusLabel,
  type LiveSyncStatus,
} from "./status.ts";

const statuses: readonly LiveSyncStatus[] = [
  "live",
  "reconnecting",
  "offline",
  "paused",
];

const shell = (liveStatus?: LiveSyncStatus): string =>
  renderToStaticMarkup(
    <AppShell
      route="today"
      onNavigate={() => undefined}
      syncStatus="online"
      liveStatus={liveStatus}
      conflictCount={0}
      baikalConnected={false}
      formError={null}
      onSignOut={() => undefined}
    >
      <p>Content</p>
    </AppShell>,
  );

describe("live sync status", () => {
  it.each(statuses)("shows %s beside the task sync status", (status) => {
    const markup = shell(status);
    expect(markup).toContain("Task sync: online");
    expect(markup).toContain(`Live updates: ${liveSyncStatusLabel(status)}`);
    // The state is text in a status region, not colour alone.
    expect(markup).toContain('role="status"');
    expect(markup).toContain(liveSyncStatusDescription(status));
  });

  it("gives each state a distinct label and description", () => {
    expect(new Set(statuses.map(liveSyncStatusLabel)).size).toBe(4);
    expect(new Set(statuses.map(liveSyncStatusDescription)).size).toBe(4);
    expect(statuses.map(liveSyncStatusDot)).toEqual([
      "online",
      "syncing",
      "offline",
      "offline",
    ]);
  });

  it("omits the row where live sync is not running", () => {
    expect(shell()).not.toContain("Live updates");
  });
});
