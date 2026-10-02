import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SignedInDevicesResponse } from "@suite/contracts";
import {
  SignedInDevicesView,
  type SignedInDevicesViewProps,
} from "./SignedInDevices.tsx";

// Signed-in devices card (issue #115, ADR 0048).
const state: SignedInDevicesResponse = {
  devices: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      label: "Firefox on Linux",
      createdAt: "2026-10-01T08:00:00.000Z",
      lastSeenAt: "2026-10-02T08:00:00.000Z",
      lastAddressFamily: "ipv4",
      expiresAt: "2026-11-01T08:00:00.000Z",
      current: true,
    },
    {
      id: "00000000-0000-4000-8000-000000000002",
      label: "Desktop app on Linux",
      createdAt: "2026-09-20T08:00:00.000Z",
      lastSeenAt: "2026-09-30T08:00:00.000Z",
      lastAddressFamily: null,
      expiresAt: "2026-10-30T08:00:00.000Z",
      current: false,
    },
  ],
  securityEvents: [],
};

const props = (
  overrides: Partial<SignedInDevicesViewProps> = {},
): SignedInDevicesViewProps => ({
  state,
  busy: false,
  online: true,
  error: null,
  renaming: null,
  onStartRename: vi.fn(),
  onRenameInput: vi.fn(),
  onSaveRename: vi.fn(),
  onCancelRename: vi.fn(),
  onSignOut: vi.fn(),
  onSignOutOthers: vi.fn(),
  ...overrides,
});

describe("signed-in devices", () => {
  it("lists each device with its state and the sign-out controls", () => {
    const html = renderToStaticMarkup(<SignedInDevicesView {...props()} />);
    expect(html).toContain("Signed-in devices");
    expect(html).toContain("Firefox on Linux");
    expect(html).toContain("This device");
    expect(html).toContain("Desktop app on Linux");
    expect(html).toContain("over IPv4");
    expect(html).toContain("over unknown network");
    expect(html.match(/>Sign out<\/button>/g)).toHaveLength(2);
    expect(html.match(/>Rename<\/button>/g)).toHaveLength(2);
    expect(html).toContain("Sign out all other devices");
    expect(html).toContain("30 days without use");
    expect(html).not.toContain("was signed out");
  });

  it("reports a device that was signed out for token reuse", () => {
    const html = renderToStaticMarkup(
      <SignedInDevicesView
        {...props({
          state: {
            devices: [],
            securityEvents: [
              {
                deviceId: "00000000-0000-4000-8000-000000000003",
                label: "Phone",
                kind: "token-reuse",
                occurredAt: "2026-10-02T09:00:00.000Z",
              },
            ],
          },
        })}
      />,
    );
    expect(html).toContain("Phone was signed out");
    expect(html).toContain("already been replaced was used again");
    expect(html).toContain("No device is kept signed in.");
  });

  it("edits a name in place and disables changes while offline", () => {
    const renaming = renderToStaticMarkup(
      <SignedInDevicesView
        {...props({
          renaming: {
            id: "00000000-0000-4000-8000-000000000002",
            label: "Study desktop",
          },
        })}
      />,
    );
    expect(renaming).toContain('value="Study desktop"');
    expect(renaming).toContain(">Save</button>");
    const offline = renderToStaticMarkup(
      <SignedInDevicesView {...props({ online: false })} />,
    );
    expect(offline).toMatch(
      /<button[^>]* disabled=""[^>]*>Sign out all other devices<\/button>/,
    );
    const loading = renderToStaticMarkup(
      <SignedInDevicesView {...props({ state: null })} />,
    );
    expect(loading).toContain("Loading devices");
  });
});
