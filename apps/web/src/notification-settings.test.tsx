import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NotificationSettings } from "./notification-settings.tsx";

describe("notification settings", () => {
  it("shows the detailed-content boundary and disables online actions offline", () => {
    const html = renderToStaticMarkup(
      <NotificationSettings
        preferences={{
          enabled: true,
          leadReminderEnabled: true,
          atStartReminderEnabled: true,
          detailedContentEnabled: true,
        }}
        status={{
          configured: true,
          enabled: true,
          state: "ready",
          pendingCount: 2,
          failedCount: 0,
          lastDelivery: null,
        }}
        busy={false}
        online={false}
        onSave={vi.fn()}
        onTest={vi.fn()}
      />,
    );
    expect(html).toContain("Remind 15 minutes before");
    expect(html).toContain("Remind at start");
    expect(html).toContain("Notes and calendar-event details are excluded");
    expect(html).toContain("Pending: 2");
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("token");
  });
});
