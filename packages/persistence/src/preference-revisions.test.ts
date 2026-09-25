import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import { SuiteDatabase } from "./index.ts";

const now = "2026-09-20T12:00:00.000Z";
const owner = {
  id: "owner",
  username: "owner",
  displayName: "Owner",
  passwordHash: "hash",
  createdAt: now,
};

it("migrates existing preference values without changing them and starts default-only owners at revision zero", async () => {
  await withTemporaryDirectory((directory) => {
    const path = join(directory, "suite.sqlite");
    let db = SuiteDatabase.open(path);
    db.createOwner(owner);
    const planning = {
      ...db.getPlanningPreferences(owner.id),
      timeZone: "Europe/London",
    };
    const notifications = {
      ...db.getNotificationPreferences(owner.id),
      enabled: true,
    };
    db.putPlanningPreferences(owner.id, planning, now);
    db.putNotificationPreferences(owner.id, notifications, now);
    db.close();
    // Build a disposable pre-0021 fixture; no production migration ledger is modified.
    const legacy = new DatabaseSync(path);
    legacy.exec(
      "DROP TRIGGER planning_preference_insert; DROP TRIGGER planning_preference_update; DROP TRIGGER notification_preference_insert; DROP TRIGGER notification_preference_update; DROP TABLE owner_preference_revisions; DELETE FROM schema_migrations WHERE id='0021_preference_revisions';",
    );
    legacy.close();
    db = SuiteDatabase.open(path);
    expect(db.getPlanningPreferences(owner.id)).toEqual(planning);
    expect(db.getNotificationPreferences(owner.id)).toEqual(notifications);
    expect(db.getPreferenceRevision(owner.id, "planning")).toBe(1);
    expect(db.getPreferenceRevision(owner.id, "notifications")).toBe(1);
    db.createOwner({ ...owner, id: "defaults", username: "defaults" });
    expect(db.getPreferenceRevision("defaults", "planning")).toBe(0);
    expect(db.getPreferenceRevision("defaults", "notifications")).toBe(0);
    db.close();
    db = SuiteDatabase.open(path);
    expect(db.getPreferenceRevision(owner.id, "planning")).toBe(1);
    expect(db.state().appliedMigrationCount).toBe(30);
    db.close();
  });
});

it("versions every browser write and rejects stale, invalid and failed conditional updates", async () => {
  await withTemporaryDirectory((directory) => {
    const path = join(directory, "suite.sqlite");
    const db = SuiteDatabase.open(path);
    db.createOwner(owner);
    const planning = db.getPlanningPreferences(owner.id),
      notifications = db.getNotificationPreferences(owner.id);
    expect(db.mutatePlanningPreferences(owner.id, 0, planning, now)).toEqual(
      planning,
    );
    expect(
      db.mutateNotificationPreferences(owner.id, 0, notifications, now),
    ).toEqual(notifications);
    db.putPlanningPreferences(owner.id, planning, now);
    db.putNotificationPreferences(owner.id, notifications, now);
    expect(db.getPreferenceRevision(owner.id, "planning")).toBe(2);
    expect(db.getPreferenceRevision(owner.id, "notifications")).toBe(2);
    expect(
      db.mutatePlanningPreferences(
        owner.id,
        1,
        { ...planning, timeZone: "UTC" },
        now,
      ),
    ).toBeUndefined();
    expect(
      db.mutateNotificationPreferences(
        owner.id,
        1,
        { ...notifications, enabled: true },
        now,
      ),
    ).toBeUndefined();
    expect(
      db.mutatePlanningPreferences(
        owner.id,
        2,
        { ...planning, timeZone: "Not/A_Zone" },
        now,
      ),
    ).toBeUndefined();
    expect(
      db.mutatePlanningPreferences(
        owner.id,
        2,
        { ...planning, workdayEnd: "01:00" },
        now,
      ),
    ).toBeUndefined();
    expect(
      db.mutatePlanningPreferences(
        owner.id,
        2,
        { ...planning, breakStart: "23:00" },
        now,
      ),
    ).toBeUndefined();
    const raw = new DatabaseSync(path);
    raw.exec(
      "CREATE TRIGGER fail_revision BEFORE UPDATE ON owner_preference_revisions BEGIN SELECT RAISE(ABORT,'injected revision failure'); END;",
    );
    expect(() =>
      db.mutatePlanningPreferences(
        owner.id,
        2,
        { ...planning, timeZone: "UTC" },
        now,
      ),
    ).toThrow("injected revision failure");
    expect(() =>
      db.mutateNotificationPreferences(
        owner.id,
        2,
        { ...notifications, enabled: true },
        now,
      ),
    ).toThrow("injected revision failure");
    expect(db.getPlanningPreferences(owner.id)).toEqual(planning);
    expect(db.getNotificationPreferences(owner.id)).toEqual(notifications);
    expect(db.getPreferenceRevision(owner.id, "planning")).toBe(2);
    expect(db.getPreferenceRevision(owner.id, "notifications")).toBe(2);
    raw.close();
    db.close();
  });
});
