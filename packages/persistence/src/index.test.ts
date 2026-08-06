import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import { SuiteDatabase } from "./index.ts";

describe("SuiteDatabase", () => {
  it("upgrades a Phase 0A database without changing its installation identity", async () => {
    await withTemporaryDirectory((directory) => {
      const path = join(directory, "suite.sqlite");
      const legacy = new DatabaseSync(path);
      const migrationSql = `
      CREATE TABLE install_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        instance_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;
    `;
      legacy.exec(`
        CREATE TABLE schema_migrations (
          id TEXT PRIMARY KEY,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL
        ) STRICT;
        ${migrationSql}
      `);
      legacy
        .prepare(
          "INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)",
        )
        .run(
          "0001_install_metadata",
          createHash("sha256").update(migrationSql).digest("hex"),
          "2026-08-05T00:00:00.000Z",
        );
      legacy
        .prepare(
          "INSERT INTO install_metadata (singleton, instance_id, created_at) VALUES (1, ?, ?)",
        )
        .run(
          "d1054acd-c04d-4bd8-a814-254b007154ba",
          "2026-08-05T00:00:00.000Z",
        );
      legacy.close();

      const upgraded = SuiteDatabase.open(path);
      expect(upgraded.state()).toMatchObject({
        install: { instanceId: "d1054acd-c04d-4bd8-a814-254b007154ba" },
        appliedMigrationCount: 4,
        expectedMigrationCount: 4,
      });
      expect(upgraded.setupRequired()).toBe(true);
      upgraded.close();
    });
  });

  it("preserves installation identity and migration state across restart", async () => {
    await withTemporaryDirectory((directory) => {
      const path = join(directory, "suite.sqlite");
      const first = SuiteDatabase.open(path);
      const firstState = first.state();
      first.close();

      const reopened = SuiteDatabase.open(path);
      const reopenedState = reopened.state();
      reopened.close();

      expect(reopenedState).toEqual(firstState);
      expect(reopenedState.appliedMigrationCount).toBe(4);
      expect(reopenedState.expectedMigrationCount).toBe(4);
    });
  });

  it("creates exactly one active owner and revokes persisted sessions", async () => {
    await withTemporaryDirectory((directory) => {
      const database = SuiteDatabase.open(join(directory, "suite.sqlite"));
      const owner = {
        id: "owner-1",
        username: "owner",
        displayName: "Owner",
        passwordHash: "not-a-real-hash",
        createdAt: "2026-08-05T00:00:00.000Z",
      };

      expect(database.createOwner(owner)).toBe(true);
      expect(database.createOwner({ ...owner, id: "owner-2" })).toBe(false);
      expect(database.findOwnerByUsername("OWNER")).toEqual(owner);

      database.createSession({
        tokenHash: "token-hash",
        ownerId: owner.id,
        csrfHash: "csrf-hash",
        issuedAt: owner.createdAt,
        idleExpiresAt: "2026-08-05T00:30:00.000Z",
        absoluteExpiresAt: "2026-08-05T12:00:00.000Z",
        revokedAt: null,
      });
      expect(database.findSession("token-hash")?.ownerId).toBe(owner.id);
      expect(
        database.revokeSession("token-hash", "2026-08-05T00:01:00.000Z"),
      ).toBe(true);
      expect(database.findSession("token-hash")?.revokedAt).toBe(
        "2026-08-05T00:01:00.000Z",
      );
      database.close();
    });
  });

  it("creates a portable SQLite backup with the same installation identity", async () => {
    await withTemporaryDirectory((directory) => {
      const sourcePath = join(directory, "suite.sqlite");
      const backupPath = join(directory, "backup", "suite.sqlite");
      const source = SuiteDatabase.open(sourcePath);
      const sourceState = source.state();
      source.backup(backupPath);
      source.close();

      expect(existsSync(backupPath)).toBe(true);

      const restored = SuiteDatabase.open(backupPath);
      expect(restored.state()).toEqual(sourceState);
      restored.close();
    });
  });
});
