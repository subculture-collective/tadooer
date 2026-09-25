import { join } from "node:path";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import { SuiteDatabase } from "./index.ts";

// Imported plugin data (issue #66, ADR 0026).
const now = "2026-09-24T12:00:00.000Z";
const later = "2026-09-24T13:00:00.000Z";
const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const secret = "SECRET-PLUGIN-CONTENT";
const odd = `\ud800 \u0000 \u2028 <img src=x onerror=alert(1)> ${secret} \udfff`;

const pluginData = {
  entries: [
    { sourceId: "brain-dump", pluginId: "brain-dump", key: null, data: odd },
    {
      sourceId: "doc-mode:doc:1",
      pluginId: "doc-mode",
      key: "doc:1",
      data: `GZ1:${secret}`,
    },
    { sourceId: "empty", pluginId: "empty", key: null, data: "" },
  ],
  plugins: [
    { pluginId: "brain-dump", enabled: true },
    { pluginId: "github-issue-provider", enabled: false },
  ],
};

const open = (directory: string) =>
  SuiteDatabase.open(join(directory, "db.sqlite"));
// Single-owner install; `other` stands for any other owner ID.
const setup = (db: SuiteDatabase) => {
  db.createOwner({
    id: owner,
    username: "owner",
    displayName: "owner",
    passwordHash: "hash",
    createdAt: now,
  });
};
const importPlugins = (
  db: SuiteDatabase,
  ownerId = owner,
  data = pluginData,
  at = now,
) => db.importTaskRecords(ownerId, [], at, undefined, { pluginData: data });

it("keeps plugin data opaque, sized and exact, scoped to its owner", async () => {
  await withTemporaryDirectory((directory) => {
    const db = open(directory);
    setup(db);
    expect(importPlugins(db)).toEqual({
      created: 0,
      existing: 0,
      pluginData: { created: 5, existing: 0 },
    });
    const list = db.pluginData.list(owner);
    expect(
      list.entries.map(({ pluginId, key, byteLength, format, revision }) => ({
        pluginId,
        key,
        byteLength,
        format,
        revision,
      })),
    ).toEqual([
      {
        pluginId: "brain-dump",
        key: null,
        byteLength: Buffer.byteLength(odd, "utf8"),
        format: "text",
        revision: 1,
      },
      {
        pluginId: "doc-mode",
        key: "doc:1",
        byteLength: 4 + secret.length,
        format: "gzip_base64",
        revision: 1,
      },
      {
        pluginId: "empty",
        key: null,
        byteLength: 0,
        format: "text",
        revision: 1,
      },
    ]);
    expect(
      list.plugins.map(({ pluginId, enabled }) => ({ pluginId, enabled })),
    ).toEqual([
      { pluginId: "brain-dump", enabled: true },
      { pluginId: "github-issue-provider", enabled: false },
    ]);
    // The listing never carries the data.
    expect(JSON.stringify(list)).not.toContain(secret);
    // Every code unit survives, including a lone surrogate and NUL.
    const entry = list.entries[0];
    expect(db.pluginData.readEntry(owner, entry?.id ?? "")?.data).toBe(odd);
    expect(db.pluginData.readEntry(other, entry?.id ?? "")).toBeUndefined();
    expect(db.pluginData.list(other)).toEqual({ plugins: [], entries: [] });
    expect(db.pluginData.deleteEntry(other, entry?.id ?? "", 1)).toBe(
      "not_found",
    );
    db.close();
  });
});

it("imports once across replay and restart and never restores a deleted record", async () => {
  await withTemporaryDirectory((directory) => {
    let db = open(directory);
    setup(db);
    importPlugins(db);
    expect(importPlugins(db, owner, pluginData, later).pluginData).toEqual({
      created: 0,
      existing: 5,
    });
    db.close();
    db = open(directory);
    const [first, ...kept] = db.pluginData.list(owner).entries;
    const plugin = db.pluginData.list(owner).plugins[0];
    expect(db.pluginData.deleteEntry(owner, first?.id ?? "", 2)).toBe(
      "conflict",
    );
    expect(db.pluginData.deleteEntry(owner, first?.id ?? "", 1)).toBe(
      "deleted",
    );
    expect(db.pluginData.deleteEntry(owner, first?.id ?? "", 1)).toBe(
      "not_found",
    );
    expect(db.pluginData.deleteMetadata(owner, plugin?.id ?? "", 1)).toBe(
      "deleted",
    );
    expect(importPlugins(db).pluginData).toEqual({ created: 0, existing: 5 });
    expect(db.pluginData.list(owner).entries).toEqual(kept);
    expect(db.pluginData.list(owner).plugins).toHaveLength(1);
    db.close();
  });
});

it("rejects a changed source value without writing anything", async () => {
  await withTemporaryDirectory((directory) => {
    const db = open(directory);
    setup(db);
    importPlugins(db);
    const before = db.pluginData.list(owner);
    const changed = {
      entries: [
        { sourceId: "new", pluginId: "new", key: null, data: "new" },
        { ...pluginData.entries[0], data: "changed" },
      ],
      plugins: [],
    };
    let failure: unknown;
    try {
      importPlugins(db, owner, changed as typeof pluginData);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("IMPORT_SOURCE_CHANGED");
    expect((failure as Error).message).not.toContain(secret);
    expect(db.pluginData.list(owner)).toEqual(before);
    db.close();
  });
});

it("bounds entries at 1 MiB of UTF-8", async () => {
  await withTemporaryDirectory((directory) => {
    const db = open(directory);
    setup(db);
    const limit = "é".repeat(512 * 1024);
    expect(
      importPlugins(db, owner, {
        entries: [{ sourceId: "p", pluginId: "p", key: null, data: limit }],
        plugins: [],
      }).pluginData,
    ).toEqual({ created: 1, existing: 0 });
    expect(() =>
      importPlugins(db, owner, {
        entries: [
          { sourceId: "q", pluginId: "q", key: null, data: `${limit}a` },
        ],
        plugins: [],
      }),
    ).toThrow("IMPORT_PLUGIN_DATA_TOO_LARGE");
    expect(db.pluginData.list(owner).entries).toHaveLength(1);
    db.close();
  });
});

it("survives backup and restore; provenance holds no plugin data", async () => {
  await withTemporaryDirectory((directory) => {
    const db = open(directory);
    setup(db);
    importPlugins(db);
    const backup = join(directory, "backup", "suite.sqlite");
    db.backup(backup);
    const original = db.pluginData.list(owner);
    db.close();

    const raw = new DatabaseSync(backup);
    const provenance = raw
      .prepare(
        "SELECT entity_kind, source_id, source_json FROM task_import_sources WHERE entity_kind LIKE 'plugin_%' ORDER BY entity_kind, source_id",
      )
      .all() as {
      entity_kind: string;
      source_id: string;
      source_json: string;
    }[];
    expect(provenance.map(({ entity_kind }) => entity_kind)).toEqual([
      "plugin_metadata",
      "plugin_metadata",
      "plugin_user_data",
      "plugin_user_data",
      "plugin_user_data",
    ]);
    expect(JSON.stringify(provenance)).not.toContain(secret);
    raw.close();
    expect(readFileSync(backup).includes(Buffer.from(secret))).toBe(true);

    const restored = SuiteDatabase.open(backup);
    expect(restored.pluginData.list(owner)).toEqual(original);
    const entry = original.entries[0];
    expect(restored.pluginData.readEntry(owner, entry?.id ?? "")?.data).toBe(
      odd,
    );
    restored.close();
  });
});
