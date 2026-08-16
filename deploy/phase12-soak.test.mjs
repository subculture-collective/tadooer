import { describe, expect, it } from "vitest";
import { parseManifest } from "./release-channel.mjs";
import { qualifySoak } from "./phase12-soak.mjs";

const start = Date.parse("2026-08-08T12:00:00.000Z");
const candidate = {
  schemaVersion: 1,
  publicOrigin: "https://tadooer.subcult.tv",
  candidate: {
    version: "0.11.0-phase11",
    revision: "efe73ee",
    imageDigest: `sha256:${"a".repeat(64)}`,
  },
  startedAt: new Date(start).toISOString(),
  observations: [],
};
const once = [
  "two_browser_profiles",
  "baikal_projection",
  "google_projection",
  "focus_break_lifecycle",
  "ntfy_lead",
  "ntfy_at_start",
  "restart_recovery",
  "isolated_restore",
  "candidate_upgrade",
  "immutable_rollback",
  "forward_recovery",
  "auth_boundary",
  "no_duplicate_calendar",
  "no_duplicate_notifications",
  "super_productivity_parallel",
];

const completeLedger = () => ({
  ...candidate,
  observations: [
    ...once.map((kind) => ({
      kind,
      status: "pass",
      at: new Date(start + 60_000).toISOString(),
    })),
    ...Array.from({ length: 7 }, (_, day) =>
      ["daily_health", "daily_backup"].map((kind) => ({
        kind,
        status: "pass",
        at: new Date(start + day * 86_400_000 + 3_600_000).toISOString(),
      })),
    ).flat(),
  ],
});

describe("Phase 12 soak qualification", () => {
  it("refuses early, incomplete, and blocking soak evidence", () => {
    expect(() =>
      qualifySoak(
        completeLedger(),
        new Date(start + 6 * 86_400_000).toISOString(),
        "Owner",
      ),
    ).toThrow("Seven full soak days");
    expect(() =>
      qualifySoak(
        { ...completeLedger(), observations: [] },
        new Date(start + 7 * 86_400_000).toISOString(),
        "Owner",
      ),
    ).toThrow("Missing soak evidence");
    expect(() =>
      qualifySoak(
        {
          ...completeLedger(),
          observations: [
            ...completeLedger().observations,
            {
              kind: "defect",
              severity: "P1",
              status: "fail",
              at: new Date(start + 86_400_000).toISOString(),
            },
          ],
        },
        new Date(start + 7 * 86_400_000).toISOString(),
        "Owner",
      ),
    ).toThrow("blocking failure");
    expect(() =>
      qualifySoak(
        {
          ...completeLedger(),
          observations: [
            ...completeLedger().observations,
            {
              kind: "daily_health",
              status: "pass",
              at: new Date(start - 1).toISOString(),
            },
          ],
        },
        new Date(start + 7 * 86_400_000).toISOString(),
        "Owner",
      ),
    ).toThrow("outside the qualification window");
  });

  it("emits a release-channel-compatible signed 1.0.0 manifest only after complete evidence", () => {
    const manifest = qualifySoak(
      completeLedger(),
      new Date(start + 7 * 86_400_000).toISOString(),
      "Owner",
    );
    expect(parseManifest(manifest)).toMatchObject({
      version: "1.0.0",
      revision: "efe73ee",
    });
    expect(manifest.signOff).toMatchObject({
      signedOffBy: "Owner",
      legacyAction: "none",
    });
  });
});
