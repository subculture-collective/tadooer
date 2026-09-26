import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { defaultApplicationPreferences } from "@suite/contracts";
import { ApplicationPreferencesSettings } from "./ApplicationPreferencesSettings.tsx";

describe("application preferences settings", () => {
  it("renders every section, the effective bindings and the offline boundary", () => {
    const html = renderToStaticMarkup(
      <ApplicationPreferencesSettings
        preferences={{
          ...defaultApplicationPreferences,
          theme: "system",
          language: "de",
          shortcuts: { "sync.now": "Ctrl+Shift+S", "help.shortcuts": null },
        }}
        revision={3}
        projects={[
          {
            id: "5b2d6d3e-1c3a-4a2b-9d4e-3f2a1b0c9d8e",
            ownerId: "d1054acd-c04d-4bd8-a814-254b007154ba",
            title: "Writing",
            revision: 1,
            createdAt: "2026-09-25T00:00:00.000Z",
            updatedAt: "2026-09-25T00:00:00.000Z",
            archivedAt: null,
            position: 0,
            color: null,
            icon: null,
            hiddenFromMenu: false,
            completedAt: null,
            backlogEnabled: false,
            backlogTaskIds: [],
          },
        ]}
        busy={false}
        online={false}
        error="Application preferences changed elsewhere."
        onSave={vi.fn()}
      />,
    );
    expect(html).toContain("Revision 3");
    expect(html).toContain("Follow the device");
    expect(html).toContain("only English is available");
    expect(html).toContain("Writing");
    expect(html).toContain("Ctrl+Shift+S");
    expect(html).toContain("Complete a parent when its last open child");
    expect(html).toContain("Reconnect to save application preferences");
    expect(html).toContain("changed elsewhere");
    expect(html).toContain('value="Ctrl+K"');
    expect(html).not.toContain("token");
  });
});
