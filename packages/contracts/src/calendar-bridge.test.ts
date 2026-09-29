import { describe, expect, it } from "vitest";
import {
  automationCalendarBridgeDeletionInputSchema,
  automationCalendarBridgeResolveInputSchema,
  automationCalendarBridgeResourceInputSchema,
  automationCatalog,
  automationConfirmationRules,
  automationTokenScopeSchema,
  calendarBridgeMappingPreviewResponseSchema,
} from "./index.ts";

// Calendar bridge controls (issue #48, ADR 0044).
const id = "00000000-0000-4000-8000-000000000001";

describe("calendar bridge controls contract", () => {
  it("declares scoped entries with their confirmation rules", () => {
    const entry = (name: string) =>
      automationCatalog.find((candidate) => candidate.id === name);
    expect(entry("calendar_bridge.status")).toMatchObject({
      kind: "resource",
      scopes: ["calendar_bridge:read"],
      confirmation: { kind: "none" },
      mcpUri: "suite://v1/calendar-bridge{?mappingId}",
    });
    for (const tool of [
      "calendar_bridge.decide_deletion",
      "calendar_bridge.resolve_conflict",
    ] as const)
      expect(entry(tool)).toMatchObject({
        kind: "tool",
        scopes: ["calendar_bridge:review"],
        confirmation: automationConfirmationRules[tool],
      });
    expect(entry("automation.confirm")?.scopes).toContain(
      "calendar_bridge:review",
    );
    expect(automationTokenScopeSchema.options).toEqual(
      expect.arrayContaining([
        "calendar_bridge:read",
        "calendar_bridge:review",
      ]),
    );
    // Mapping creation, pause, removal and passes stay owner-only.
    expect(
      automationCatalog.filter(({ id: name }) =>
        name.startsWith("calendar_bridge."),
      ),
    ).toHaveLength(3);
  });

  it("binds every review decision to a revision and rejects extra fields", () => {
    const deletion = {
      mappingId: id,
      linkId: id,
      expectedRevision: 3,
      decision: "approve",
    };
    expect(automationCalendarBridgeDeletionInputSchema.parse(deletion)).toEqual(
      deletion,
    );
    const { expectedRevision: _revision, ...unbound } = deletion;
    void _revision;
    expect(
      automationCalendarBridgeDeletionInputSchema.safeParse(unbound).success,
    ).toBe(false);
    expect(
      automationCalendarBridgeDeletionInputSchema.safeParse({
        ...deletion,
        decision: "delete-all",
      }).success,
    ).toBe(false);
    const resolve = {
      mappingId: id,
      conflictId: id,
      keep: "baikal",
      expectedLinkRevision: 2,
    };
    expect(automationCalendarBridgeResolveInputSchema.parse(resolve)).toEqual(
      resolve,
    );
    expect(
      automationCalendarBridgeResolveInputSchema.safeParse({
        ...resolve,
        keep: "both",
      }).success,
    ).toBe(false);
    expect(automationCalendarBridgeResourceInputSchema.parse({})).toEqual({});
    expect(
      automationCalendarBridgeResourceInputSchema.safeParse({ mappingId: "x" })
        .success,
    ).toBe(false);
  });

  it("limits the creation preview sample to ten events", () => {
    const sample = Array.from({ length: 11 }, () => ({
      summary: "Event",
      startsAt: "2026-10-01T15:00:00.000Z",
      allDay: false,
    }));
    const preview = {
      direction: "two_way",
      initialSync: "copy_existing",
      refusals: [],
      copies: [
        {
          from: "google",
          to: "baikal",
          existing: 11,
          copied: 11,
          repeating: 0,
          sample,
          readAt: null,
        },
      ],
    };
    expect(
      calendarBridgeMappingPreviewResponseSchema.safeParse(preview).success,
    ).toBe(false);
  });
});
