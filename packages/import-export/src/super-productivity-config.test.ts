import { describe, expect, it } from "vitest";
import { prepareSuperProductivityImport } from "./super-productivity-apply.ts";
import {
  mapSuperProductivityGlobalConfig,
  superProductivityGlobalConfigFields,
  superProductivityGlobalConfigSections,
  type ConfigFinding,
} from "./super-productivity-config.ts";

/** GlobalConfigState keys in Super Productivity 19.1.0 global-config.model.ts. */
const sourceSections = [
  "appFeatures",
  "localization",
  "misc",
  "tasks",
  "shortSyntax",
  "evaluation",
  "idle",
  "takeABreak",
  "pomodoro",
  "flowtime",
  "keyboard",
  "localBackup",
  "sound",
  "timeTracking",
  "reminder",
  "schedule",
  "dominaMode",
  "focusMode",
  "clipboardImages",
  "sync",
  "dailySummaryNote",
];

const marker = "CREDENTIAL-MARKER-7f3a";
const state = (entities: Record<string, unknown>) => ({
  ids: Object.keys(entities),
  entities,
});
const exportWith = (globalConfig: unknown) =>
  JSON.stringify({
    task: state({ t: { id: "t", title: "Task" } }),
    project: state({ p: { id: "p", title: "Project" } }),
    tag: state({}),
    globalConfig,
  });

describe("globalConfig classification (ADR 0030)", () => {
  it("classifies every source section and field exactly once", () => {
    expect(
      Object.keys(superProductivityGlobalConfigSections).toSorted(),
    ).toEqual(sourceSections.toSorted());
    for (const [key, disposition] of Object.entries(
      superProductivityGlobalConfigFields,
    )) {
      expect(key.split(".")).toHaveLength(2);
      expect(["applied", "transform", "excluded", "deferred"]).toContain(
        disposition,
      );
    }
    // Credentials and provider configuration are excluded as whole sections.
    expect(superProductivityGlobalConfigSections.sync.disposition).toBe(
      "excluded",
    );
    expect(superProductivityGlobalConfigFields["misc.unsplashApiKey"]).toBe(
      "excluded",
    );
  });

  it("maps safe settings, converts units and options, and counts the rest", () => {
    const findings: ConfigFinding[] = [];
    const mapped = mapSuperProductivityGlobalConfig(
      {
        localization: { lng: "de", firstDayOfWeek: 0, dateTimeLocale: "en-gb" },
        misc: {
          startOfNextDayTime: "3:00",
          defaultStartPage: 2,
          isMinimizeToTray: true,
          customTheme: "dark",
          unsplashApiKey: marker,
          isAutMarkParentAsDone: true,
        },
        tasks: {
          isAutoMarkParentAsDone: true,
          isAutoAddWorkedOnToToday: false,
          isConfirmBeforeDelete: false,
          isMarkdownFormattingInNotesEnabled: false,
          defaultProjectId: "p",
          notesTemplate: "**Why?**",
        },
        keyboard: {
          addNewTask: "Shift+A",
          togglePlay: "Ctrl+Space",
          showHelp: "?",
          showSearchBar: "Shift+F",
          triggerSync: "Ctrl+S",
          goToSettings: null,
          taskToggleDone: "Shift+F",
          zoomIn: "Ctrl++",
          taskDelete: "Backspace",
          plugin_x: "Ctrl+X",
        },
        timeTracking: {
          defaultEstimate: 1_800_000,
          defaultEstimateSubTasks: 90_000,
          isNotifyWhenTimeEstimateExceeded: false,
          isTrackingReminderEnabled: true,
        },
        reminder: {
          defaultTaskRemindOption: "m10",
          notifyOnDueDate: false,
          dueDateNotificationHour: 8,
          disableReminders: true,
        },
        schedule: {
          isWorkStartEndEnabled: true,
          workStart: "9:00",
          workEnd: "17:30",
          isLunchBreakEnabled: true,
          lunchBreakStart: "12:00",
          lunchBreakEnd: "12:45",
        },
        sync: { syncProvider: "WebDAV", webDav: { password: marker } },
        idle: { minIdleTime: 300000 },
        dailySummaryNote: { txt: "Review", lastUpdateDayStr: "2026-09-24" },
        futureSection: { a: 1 },
      },
      (found) => findings.push(found),
    );
    expect(mapped?.preferences).toEqual({
      language: "de",
      firstDayOfWeek: 0,
      dateTimeLocale: "en-GB",
      defaultStartPage: "planner",
      autoMarkParentDone: true,
      autoAddWorkedOnToToday: false,
      confirmBeforeDelete: false,
      markdownInNotes: false,
      defaultProjectSourceId: "p",
      defaultEstimateMinutes: 30,
      notifyWhenEstimateExceeded: false,
      defaultTaskReminder: { kind: "before_start", minutes: 10 },
      notifyOnDueDate: false,
      dueDateNotificationHour: 8,
      dailySummaryNote: "Review",
      shortcuts: {
        "task.add": "Shift+A",
        "focus.toggle": "Ctrl+Space",
        "help.shortcuts": "?",
        "command_bar.open": "Shift+F",
        "sync.now": "Ctrl+S",
        "navigate.settings": null,
      },
    });
    expect(mapped?.planning).toEqual({
      dayStartsAt: "03:00",
      workdayStart: "09:00",
      workdayEnd: "17:30",
      breakStart: "12:00",
      breakEnd: "12:45",
    });
    // A 90 s estimate is not a whole minute count: reported, not rounded.
    expect(
      findings
        .filter(({ code }) => code === "config_field_retained")
        .map(({ sourceId }) => sourceId),
    ).toEqual(
      expect.arrayContaining([
        "globalConfig.futureSection",
        "globalConfig.timeTracking",
        "globalConfig.tasks",
        "globalConfig.idle",
        "globalConfig.keyboard",
      ]),
    );
    // taskToggleDone collides with the search-bar binding and stays out.
    expect(
      findings.some(({ detail }) =>
        detail.includes("task.toggle_done collides"),
      ),
    ).toBe(true);
    expect(mapped?.counts).toMatchObject({ shortcuts: 6, planning: 5 });
    const excluded = findings.filter(
      ({ code }) => code === "config_field_excluded",
    );
    expect(excluded.map(({ sourceId }) => sourceId)).toEqual(
      expect.arrayContaining([
        "globalConfig.sync",
        "globalConfig.misc",
        "globalConfig.keyboard",
        "globalConfig.reminder",
        "globalConfig.dailySummaryNote",
      ]),
    );
    expect(
      findings.filter(({ code }) => code === "config_applied"),
    ).toHaveLength(1);
    expect(JSON.stringify({ mapped, findings })).not.toContain(marker);
    expect(JSON.stringify(findings)).not.toContain("Shift+A");
  });

  it("never blocks an import, applies nothing for an empty config and keeps credentials out of the prepared import", () => {
    const empty = prepareSuperProductivityImport(exportWith({}));
    expect(empty.applicationPreferences).toBeUndefined();
    expect(empty.report.canApply).toBe(true);
    const secret = prepareSuperProductivityImport(
      exportWith({
        sync: { superSync: { accessToken: marker, encryptKey: marker } },
        misc: { unsplashApiKey: marker, startOfNextDayTime: "not a time" },
        secret: marker,
      }),
    );
    expect(secret.report.canApply).toBe(true);
    expect(secret.applicationPreferences).toBeUndefined();
    expect(JSON.stringify(secret)).not.toContain(marker);
    expect(
      secret.report.issues.map(({ code, blocking }) => [code, blocking]),
    ).toEqual(
      expect.arrayContaining([
        ["config_field_excluded", false],
        ["config_field_retained", false],
      ]),
    );
    const applied = prepareSuperProductivityImport(
      exportWith({ tasks: { isConfirmBeforeDelete: false } }),
    );
    expect(applied.applicationPreferences).toEqual({
      preferences: { confirmBeforeDelete: false },
      planning: {},
    });
    expect(applied.report.issues.map(({ code }) => code)).toEqual([
      "config_applied",
    ]);
  });
});
