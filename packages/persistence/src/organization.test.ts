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

it("persists revisioned organization lifecycle and rejects invalid or cross-owner edits without sync changes", async () => {
  await withTemporaryDirectory((directory) => {
    const path = join(directory, "suite.sqlite");
    let db = SuiteDatabase.open(path);
    db.createOwner(owner);
    for (const kind of ["project", "tag"] as const) {
      expect(
        db.mutateOrganization(
          kind,
          owner.id,
          kind,
          null,
          { title: " Home " },
          now,
        ),
      ).toMatchObject({ title: "Home", revision: 1 });
      expect(
        db.mutateOrganization(
          kind,
          owner.id,
          kind,
          1,
          { title: "Office" },
          now,
        ),
      ).toMatchObject({ title: "Office", revision: 2 });
      expect(
        db.mutateOrganization(kind, owner.id, kind, 2, { archived: true }, now),
      ).toMatchObject({ archivedAt: now, revision: 3 });
      expect(
        db.mutateOrganization(
          kind,
          owner.id,
          kind,
          3,
          { archived: false },
          now,
        ),
      ).toMatchObject({ archivedAt: null, revision: 4 });
      const before = db.getSyncState(owner.id);
      expect(
        db.mutateOrganization(
          kind,
          "other-owner",
          kind,
          4,
          { title: "Wrong" },
          now,
        ),
      ).toBeUndefined();
      expect(
        db.mutateOrganization(kind, owner.id, kind, 3, { title: "Stale" }, now),
      ).toBeUndefined();
      expect(
        db.mutateOrganization(kind, owner.id, kind, 4, { title: " " }, now),
      ).toBeUndefined();
      expect(
        db.mutateOrganization(
          kind,
          owner.id,
          kind,
          4,
          { title: "x".repeat(241) },
          now,
        ),
      ).toBeUndefined();
      expect(
        db.mutateOrganization(kind, owner.id, kind, 4, {}, now),
      ).toBeUndefined();
      expect(db.getSyncState(owner.id)).toEqual(before);
    }
    const before = db.getSyncState(owner.id);
    expect(() =>
      db.mutateOrganization(
        "tag",
        owner.id,
        "duplicate",
        null,
        { title: "ＯＦＦＩＣＥ" },
        now,
      ),
    ).toThrow();
    expect(db.getSyncState(owner.id)).toEqual(before);
    db.close();
    db = SuiteDatabase.open(path);
    expect(db.listProjects(owner.id)).toMatchObject([
      { title: "Office", revision: 4, archivedAt: null },
    ]);
    expect(db.listTags(owner.id)).toMatchObject([
      {
        title: "Office",
        normalizedName: "office",
        revision: 4,
        archivedAt: null,
      },
    ]);
    db.close();
    const raw = new DatabaseSync(path);
    expect(
      raw.prepare("SELECT count(*) AS count FROM sync_changes").get(),
    ).toMatchObject({ count: 8 });
    raw.close();
  });
});

it("rolls back entity writes when publishing the corresponding sync change fails", async () => {
  await withTemporaryDirectory((directory) => {
    const path = join(directory, "suite.sqlite");
    const db = SuiteDatabase.open(path);
    db.createOwner(owner);
    const raw = new DatabaseSync(path);
    raw.exec(
      "CREATE TRIGGER fail_sync BEFORE INSERT ON sync_changes BEGIN SELECT RAISE(ABORT, 'injected sync failure'); END;",
    );
    for (const kind of ["project", "tag"] as const) {
      expect(() =>
        db.mutateOrganization(
          kind,
          owner.id,
          kind,
          null,
          { title: "Home" },
          now,
        ),
      ).toThrow("injected sync failure");
    }
    expect(db.listProjects(owner.id)).toEqual([]);
    expect(db.listTags(owner.id)).toEqual([]);
    raw.close();
    db.close();
  });
});

it("nests lifecycle and task assignments in the confirmation transaction and rolls everything back on audit failure", async () => {
  await withTemporaryDirectory((directory) => {
    const path = join(directory, "suite.sqlite");
    const db = SuiteDatabase.open(path);
    db.createOwner(owner);
    db.createTaskIdempotently(owner.id, "task", "create", {
      id: "task",
      title: "Task",
      notes: "",
      status: "open",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    db.createAutomationToken({
      id: "token",
      ownerId: owner.id,
      label: "Test",
      secretHash: "hash",
      scopes: [],
      createdAt: now,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    });
    db.createAutomationPreview({
      id: "preview",
      ownerId: owner.id,
      tokenId: "token",
      operation: "test",
      inputHash: "hash",
      input: {},
      summary: "Test",
      affectedIds: [],
      baseRevisions: {},
      expiresAt: "2026-09-21T12:00:00.000Z",
      consumedAt: null,
      createdAt: now,
    });
    const before = db.getSyncState(owner.id);
    const raw = new DatabaseSync(path);
    raw.exec(
      "CREATE TRIGGER fail_audit BEFORE INSERT ON automation_audit_log BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END;",
    );
    const confirm = () =>
      db.completeAutomationConfirmation(
        "preview",
        {
          ownerId: owner.id,
          tokenId: "token",
          operation: "test",
          idempotencyKey: "key",
          requestHash: "hash",
          previewId: "preview",
          response: {},
          createdAt: now,
        },
        {
          id: "audit",
          ownerId: owner.id,
          tokenId: "token",
          operation: "test",
          phase: "confirm",
          outcome: "succeeded",
          errorCode: null,
          previewId: "preview",
          affectedIds: [],
          requestHash: "hash",
          createdAt: now,
        },
        now,
        () => {
          db.mutateOrganization(
            "project",
            owner.id,
            "project",
            null,
            { title: "Project" },
            now,
          );
          db.mutateOrganization(
            "tag",
            owner.id,
            "tag",
            null,
            { title: "Tag" },
            now,
          );
          expect(
            db.assignTaskProject(owner.id, "task", "project", 1, now),
          ).toMatchObject({ revision: 2 });
          expect(db.setTaskTags(owner.id, "task", ["tag"], 2, now)).toBe(true);
          expect(
            db.mutatePlanningPreferences(
              owner.id,
              0,
              { ...db.getPlanningPreferences(owner.id), timeZone: "UTC" },
              now,
            ),
          ).toBeDefined();
          expect(
            db.mutateNotificationPreferences(
              owner.id,
              0,
              { ...db.getNotificationPreferences(owner.id), enabled: true },
              now,
            ),
          ).toBeDefined();
          return { ok: true };
        },
      );
    expect(confirm).toThrow("injected audit failure");
    expect(db.getPreferenceRevision(owner.id, "planning")).toBe(0);
    expect(db.getPreferenceRevision(owner.id, "notifications")).toBe(0);
    expect(db.listProjects(owner.id)).toEqual([]);
    expect(db.listTags(owner.id)).toEqual([]);
    expect(db.getTask(owner.id, "task")).toMatchObject({
      revision: 1,
      projectId: null,
      tagIds: [],
    });
    expect(db.getSyncState(owner.id)).toEqual(before);
    expect(db.getAutomationPreview("preview")?.consumedAt).toBeNull();
    expect(
      raw
        .prepare("SELECT count(*) AS count FROM automation_operation_outcomes")
        .get(),
    ).toMatchObject({ count: 0 });
    raw.exec("DROP TRIGGER fail_audit;");
    expect(confirm()).toBe(true);
    expect(db.getPreferenceRevision(owner.id, "planning")).toBe(1);
    expect(db.getPreferenceRevision(owner.id, "notifications")).toBe(1);
    expect(db.getTask(owner.id, "task")).toMatchObject({
      revision: 3,
      projectId: "project",
      tagIds: ["tag"],
    });
    raw.close();
    db.close();
  });
});
