import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import { SuiteDatabase } from "./index.ts";

const now = "2026-09-24T12:00:00.000Z";
const later = "2026-09-24T13:00:00.000Z";
const owner = (id: string) => ({
  id,
  username: id,
  displayName: id,
  passwordHash: "hash",
  createdAt: now,
});
const task = (db: SuiteDatabase, id: string) =>
  db.createTaskIdempotently("owner", id, id, {
    id,
    title: id,
    notes: "",
    status: "open",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });

it("completes, reopens, archives and restores projects without dropping task assignments", async () => {
  await withTemporaryDirectory((directory) => {
    const path = join(directory, "suite.sqlite");
    let db = SuiteDatabase.open(path);
    db.createOwner(owner("owner"));
    db.mutateOrganization(
      "project",
      "owner",
      "p",
      null,
      { title: "Launch", color: "#AABBCC", icon: "rocket_launch" },
      now,
    );
    task(db, "t");
    expect(db.assignTaskProject("owner", "t", "p", 1, now)).toBeDefined();
    const completed = db.mutateOrganization(
      "project",
      "owner",
      "p",
      1,
      { completed: true },
      later,
    );
    expect(completed).toMatchObject({
      revision: 2,
      completedAt: later,
      archivedAt: later,
      color: "#aabbcc",
      icon: "rocket_launch",
    });
    // Archive and completion cannot change together; tags have no completion.
    expect(
      db.mutateOrganization(
        "project",
        "owner",
        "p",
        2,
        { archived: false, completed: false },
        later,
      ),
    ).toBeUndefined();
    expect(
      db.mutateOrganization("project", "owner", "p", 2, { icon: "<b>" }, later),
    ).toBeUndefined();
    expect(
      db.mutateOrganization(
        "project",
        "owner",
        "p",
        2,
        { color: "red" },
        later,
      ),
    ).toBeUndefined();
    db.mutateOrganization("tag", "owner", "g", null, { title: "Tag" }, now);
    expect(
      db.mutateOrganization("tag", "owner", "g", 1, { completed: true }, now),
    ).toBeUndefined();
    expect(db.getTask("owner", "t")?.projectId).toBe("p");
    db.close();
    db = SuiteDatabase.open(path);
    // Restore clears completion as well (Super Productivity 19.1.0 unarchive).
    expect(
      db.mutateOrganization(
        "project",
        "owner",
        "p",
        2,
        { archived: false },
        later,
      ),
    ).toMatchObject({ revision: 3, archivedAt: null, completedAt: null });
    db.mutateOrganization(
      "project",
      "owner",
      "p",
      3,
      { completed: true },
      later,
    );
    expect(
      db.mutateOrganization(
        "project",
        "owner",
        "p",
        4,
        { completed: false },
        later,
      ),
    ).toMatchObject({ revision: 5, archivedAt: null, completedAt: null });
    expect(db.getTask("owner", "t")?.projectId).toBe("p");
    db.close();
  });
});

it("reorders complete membership, rejects stale revisions and publishes only moved records", async () => {
  await withTemporaryDirectory((directory) => {
    const db = SuiteDatabase.open(join(directory, "suite.sqlite"));
    db.createOwner(owner("owner"));
    for (const [id, title] of [
      ["a", "Alpha"],
      ["b", "Beta"],
      ["c", "Gamma"],
    ] as const) {
      db.mutateOrganization("project", "owner", id, null, { title }, now);
      db.mutateOrganization("tag", "owner", id, null, { title }, now);
    }
    expect(db.listProjects("owner").map(({ position }) => position)).toEqual([
      0, 1, 2,
    ]);
    const before = db.getSyncState("owner");
    const order = [
      { id: "c", revision: 1 },
      { id: "a", revision: 1 },
      { id: "b", revision: 1 },
    ];
    expect(
      db.reorderOrganization("project", "owner", order, later),
    ).toMatchObject([
      { id: "c", position: 0, revision: 2 },
      { id: "a", position: 1, revision: 2 },
      { id: "b", position: 2, revision: 2 },
    ]);
    expect(db.getSyncState("owner").cursor).toBe(before.cursor + 3);
    // Stale revisions, partial membership and duplicates are rejected unchanged.
    const afterMove = db.getSyncState("owner");
    for (const items of [
      order,
      order.slice(0, 2),
      [order[0], order[0], order[1]].filter((item) => item !== undefined),
    ])
      expect(
        db.reorderOrganization("project", "owner", items, later),
      ).toBeUndefined();
    expect(db.getSyncState("owner")).toEqual(afterMove);
    // Unmoved records keep their revision.
    expect(
      db
        .reorderOrganization(
          "tag",
          "owner",
          [
            { id: "a", revision: 1 },
            { id: "c", revision: 1 },
            { id: "b", revision: 1 },
          ],
          later,
        )
        ?.map(({ id, revision }) => `${id}:${String(revision)}`),
    ).toEqual(["a:1", "c:2", "b:2"]);
    // Other owners cannot reorder these records.
    expect(
      db.reorderOrganization("tag", "other", [{ id: "a", revision: 1 }], later),
    ).toBeUndefined();
    db.close();
  });
});

it("moves tasks into and out of a project backlog and keeps membership with its task", async () => {
  await withTemporaryDirectory((directory) => {
    const path = join(directory, "suite.sqlite");
    let db = SuiteDatabase.open(path);
    db.createOwner(owner("owner"));
    db.mutateOrganization("project", "owner", "p", null, { title: "P" }, now);
    db.mutateOrganization("project", "owner", "q", null, { title: "Q" }, now);
    task(db, "t");
    task(db, "u");
    db.assignTaskProject("owner", "t", "p", 1, now);
    db.assignTaskProject("owner", "u", "p", 1, now);
    // Backlog must be enabled first.
    expect(db.setProjectBacklog("owner", "p", 1, "t", true, now).kind).toBe(
      "invalid",
    );
    db.mutateOrganization(
      "project",
      "owner",
      "p",
      1,
      { backlogEnabled: true },
      now,
    );
    expect(db.setProjectBacklog("owner", "p", 1, "t", true, now).kind).toBe(
      "conflict",
    );
    const moved = db.setProjectBacklog("owner", "p", 2, "t", true, now);
    expect(moved).toMatchObject({
      kind: "applied",
      project: { revision: 3, backlogTaskIds: ["t"] },
    });
    db.setProjectBacklog("owner", "p", 3, "u", true, now);
    // Repeating a move is rejected rather than silently bumping a revision.
    expect(db.setProjectBacklog("owner", "p", 4, "t", true, now).kind).toBe(
      "invalid",
    );
    // A task of another project cannot enter this backlog.
    task(db, "v");
    db.assignTaskProject("owner", "v", "q", 1, now);
    expect(db.setProjectBacklog("owner", "p", 4, "v", true, now).kind).toBe(
      "invalid",
    );
    // Deleted tasks leave the list and return on restore.
    db.deleteTask("owner", "u", 2, now);
    expect(db.listProjects("owner")[0]?.backlogTaskIds).toEqual(["t"]);
    db.restoreTask("owner", "u", 3, now);
    expect(db.listProjects("owner")[0]?.backlogTaskIds).toEqual(["t", "u"]);
    db.close();
    db = SuiteDatabase.open(path);
    // Reassigning the task removes its membership and advances the old project.
    const task2 = db.getTask("owner", "t");
    if (task2 === undefined) throw new Error("missing task");
    db.assignTaskProject("owner", "t", "q", task2.revision, now);
    expect(db.listProjects("owner")[0]).toMatchObject({
      id: "p",
      revision: 5,
      backlogTaskIds: ["u"],
    });
    // Moving out of the backlog, then disabling it, empties membership.
    expect(
      db.setProjectBacklog("owner", "p", 5, "u", false, now),
    ).toMatchObject({ kind: "applied", project: { backlogTaskIds: [] } });
    db.setProjectBacklog("owner", "p", 6, "u", true, now);
    expect(
      db.mutateOrganization(
        "project",
        "owner",
        "p",
        7,
        { backlogEnabled: false },
        now,
      ),
    ).toMatchObject({ backlogEnabled: false, backlogTaskIds: [] });
    db.close();
  });
});

it("keeps notes owner-scoped, revisioned and ordered across restart", async () => {
  await withTemporaryDirectory((directory) => {
    const path = join(directory, "suite.sqlite");
    let db = SuiteDatabase.open(path);
    db.createOwner(owner("owner"));
    db.mutateOrganization("project", "owner", "p", null, { title: "P" }, now);
    db.mutateOrganization("tag", "owner", "g", null, { title: "G" }, now);
    const create = (id: string, extra = {}) =>
      db.notes.create(
        "owner",
        {
          id,
          content: `Note ${id}`,
          projectId: null,
          tagId: null,
          pinnedToToday: false,
          ...extra,
        },
        now,
      );
    expect(create("n1", { projectId: "p" })).toMatchObject({
      kind: "applied",
      notes: [{ id: "n1", projectId: "p", position: 0, revision: 1 }],
    });
    create("n2", { tagId: "g", pinnedToToday: true });
    create("n3");
    // Invalid content, both associations, or a project the owner lacks.
    expect(create("bad", { content: "   " }).kind).toBe("invalid");
    expect(create("bad", { projectId: "p", tagId: "g" }).kind).toBe("invalid");
    expect(create("bad", { projectId: "x" }).kind).toBe("invalid");
    expect(create("n1").kind).toBe("conflict");
    expect(db.notes.list("other")).toEqual([]);
    expect(db.notes.get("other", "n1")).toBeUndefined();
    expect(db.notes.update("other", "n1", 1, { content: "x" }, now).kind).toBe(
      "conflict",
    );
    expect(db.notes.delete("other", "n1", 1, later).kind).toBe("conflict");
    // Choosing a tag clears the project.
    expect(
      db.notes.update(
        "owner",
        "n1",
        1,
        { tagId: "g", content: "Moved" },
        later,
      ),
    ).toMatchObject({
      kind: "applied",
      notes: [{ projectId: null, tagId: "g", content: "Moved", revision: 2 }],
    });
    expect(
      db.notes.update("owner", "n1", 1, { content: "Stale" }, later).kind,
    ).toBe("conflict");
    const order = [
      { id: "n3", revision: 1 },
      { id: "n1", revision: 2 },
      { id: "n2", revision: 1 },
    ];
    expect(db.notes.reorder("owner", order.slice(1), later).kind).toBe(
      "conflict",
    );
    expect(
      db.notes.reorder("owner", order, later).kind === "applied" &&
        db.notes.list("owner").map(({ id }) => id),
    ).toEqual(["n3", "n1", "n2"]);
    db.close();
    db = SuiteDatabase.open(path);
    expect(db.notes.list("owner")).toMatchObject([
      { id: "n3", position: 0 },
      { id: "n1", position: 1, content: "Moved" },
      { id: "n2", position: 2, pinnedToToday: true },
    ]);
    expect(db.notes.delete("owner", "n2", 1, later).kind).toBe("conflict");
    expect(db.notes.delete("owner", "n2", 2, later).kind).toBe("applied");
    expect(db.notes.get("owner", "n2")).toBeUndefined();
    // ADR 0046: every note write appended a feed change; failed writes and
    // unmoved notes appended none.
    const raw = new DatabaseSync(path);
    expect(
      raw
        .prepare(
          "SELECT entity_id, kind, revision FROM sync_changes WHERE entity_type='note' ORDER BY sequence",
        )
        .all(),
    ).toEqual([
      { entity_id: "n1", kind: "upsert", revision: 1 },
      { entity_id: "n2", kind: "upsert", revision: 1 },
      { entity_id: "n3", kind: "upsert", revision: 1 },
      { entity_id: "n1", kind: "upsert", revision: 2 },
      { entity_id: "n3", kind: "upsert", revision: 2 },
      { entity_id: "n1", kind: "upsert", revision: 3 },
      { entity_id: "n2", kind: "upsert", revision: 2 },
      { entity_id: "n2", kind: "deleted", revision: 3 },
    ]);
    raw.close();
    db.close();
  });
});

it("imports organization state, notes and backlog once and replays idempotently", async () => {
  await withTemporaryDirectory((directory) => {
    const path = join(directory, "suite.sqlite");
    let db = SuiteDatabase.open(path);
    db.createOwner(owner("owner"));
    const base = {
      sourceHash: "",
      sourceJson: "{}",
      title: "",
      notes: "",
      projectId: null,
      tagIds: [],
      plannedStart: null,
      deadlineDate: null,
      deadlineAt: null,
      estimateMinutes: null,
      completedAt: null,
      createdAt: null,
    };
    const records = [
      {
        ...base,
        kind: "project" as const,
        sourceId: "open",
        sourceHash: "h1",
        title: "Open",
        backlogEnabled: true,
        backlogTaskIds: ["t2"],
        hiddenFromMenu: true,
      },
      {
        ...base,
        kind: "project" as const,
        sourceId: "done",
        sourceHash: "h2",
        title: "Done",
        completedAt: "2026-01-01T00:00:00.000Z",
        archived: true,
        color: "#112233",
        icon: "work",
      },
      {
        ...base,
        kind: "tag" as const,
        sourceId: "tag",
        sourceHash: "h3",
        title: "Tag",
        archived: true,
        color: "#445566",
      },
      ...["t1", "t2"].map((sourceId) => ({
        ...base,
        kind: "task" as const,
        sourceId,
        sourceHash: sourceId,
        title: sourceId,
        projectId: "open",
      })),
      {
        ...base,
        kind: "note" as const,
        sourceId: "n",
        sourceHash: "h4",
        notes: "See [docs](https://example.com)",
        projectId: "open",
        pinnedToToday: true,
        createdAt: "2026-02-01T00:00:00.000Z",
      },
    ];
    expect(db.importTaskRecords("owner", records, now)).toEqual({
      created: 6,
      existing: 0,
    });
    const [open, done] = db.listProjects("owner");
    const t2 = db.listTasks("owner").find(({ title }) => title === "t2");
    expect(open).toMatchObject({
      title: "Open",
      position: 0,
      hiddenFromMenu: true,
      backlogEnabled: true,
      backlogTaskIds: [t2?.id],
    });
    expect(done).toMatchObject({
      completedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: "2026-01-01T00:00:00.000Z",
      color: "#112233",
      icon: "work",
      position: 1,
    });
    expect(db.listTags("owner")[0]).toMatchObject({
      archivedAt: now,
      color: "#445566",
    });
    expect(db.notes.list("owner")).toMatchObject([
      {
        content: "See [docs](https://example.com)",
        projectId: open?.id,
        pinnedToToday: true,
        createdAt: "2026-02-01T00:00:00.000Z",
      },
    ]);
    // Local edits survive replay; replay creates nothing.
    const note = db.notes.list("owner")[0];
    if (note === undefined || open === undefined) throw new Error("missing");
    // ADR 0046: the imported note is in the feed, in the import transaction.
    const noteChanges = () =>
      db
        .listSyncChanges("owner", db.getSyncState("owner").epoch, 0)
        .filter(({ entityType }) => entityType === "note")
        .map(({ entityId, kind, revision }) => ({ entityId, kind, revision }));
    expect(noteChanges()).toEqual([
      { entityId: note.id, kind: "upsert", revision: 1 },
    ]);
    expect(db.fullSyncSnapshot("owner").notes).toMatchObject([
      { id: note.id, pinnedToToday: true },
    ]);
    db.notes.update("owner", note.id, 1, { content: "Edited" }, later);
    db.close();
    db = SuiteDatabase.open(path);
    expect(db.importTaskRecords("owner", records, later)).toEqual({
      created: 0,
      existing: 6,
    });
    // Replay writes no note, so it appends no note change either.
    expect(noteChanges()).toEqual([
      { entityId: note.id, kind: "upsert", revision: 1 },
      { entityId: note.id, kind: "upsert", revision: 2 },
    ]);
    expect(db.notes.list("owner")).toMatchObject([{ content: "Edited" }]);
    expect(db.listProjects("owner")[0]?.backlogTaskIds).toHaveLength(1);
    // A changed source note is refused as a whole.
    const before = db.notes.list("owner");
    expect(() =>
      db.importTaskRecords(
        "owner",
        [
          {
            ...base,
            kind: "note",
            sourceId: "new",
            sourceHash: "x",
            notes: "New",
          },
          { ...records[5], sourceHash: "changed" } as (typeof records)[number],
        ],
        later,
      ),
    ).toThrow("IMPORT_SOURCE_CHANGED");
    expect(db.notes.list("owner")).toEqual(before);
    db.close();
  });
});

it("backfills title order for projects and tags that predate migration 0022", async () => {
  await withTemporaryDirectory((directory) => {
    const path = join(directory, "suite.sqlite");
    let db = SuiteDatabase.open(path);
    db.createOwner(owner("owner"));
    db.close();
    // Rebuild the 0021 schema shape, then add rows without the new columns.
    const raw = new DatabaseSync(path);
    raw.exec(`
      DROP TABLE notes;
      DROP TABLE project_backlog_tasks;
      ALTER TABLE projects DROP COLUMN color;
      ALTER TABLE projects DROP COLUMN icon;
      ALTER TABLE projects DROP COLUMN position;
      ALTER TABLE projects DROP COLUMN hidden_from_menu;
      ALTER TABLE projects DROP COLUMN completed_at;
      ALTER TABLE projects DROP COLUMN backlog_enabled;
      ALTER TABLE tags DROP COLUMN color;
      ALTER TABLE tags DROP COLUMN icon;
      ALTER TABLE tags DROP COLUMN position;
      DELETE FROM schema_migrations WHERE id = '0022_organization_parity';
    `);
    const insert = raw.prepare(
      "INSERT INTO projects (id, owner_id, title, revision, created_at, updated_at, archived_at) VALUES (?, 'owner', ?, 1, ?, ?, NULL)",
    );
    for (const [id, title] of [
      ["z", "zeta"],
      ["a", "Alpha"],
      ["m", "mid"],
    ])
      insert.run(id ?? "", title ?? "", now, now);
    raw
      .prepare(
        "INSERT INTO tags (id, owner_id, display_name, normalized_name, revision, created_at, updated_at, archived_at) VALUES ('t2', 'owner', 'Beta', 'beta', 1, ?, ?, NULL), ('t1', 'owner', 'alpha', 'alpha', 1, ?, ?, NULL)",
      )
      .run(now, now, now, now);
    raw.close();
    db = SuiteDatabase.open(path);
    expect(
      db
        .listProjects("owner")
        .map(({ id, position }) => `${id}:${String(position)}`),
    ).toEqual(["a:0", "m:1", "z:2"]);
    expect(
      db
        .listTags("owner")
        .map(({ id, position }) => `${id}:${String(position)}`),
    ).toEqual(["t1:0", "t2:1"]);
    expect(db.listProjects("owner")[0]).toMatchObject({
      color: null,
      completedAt: null,
      backlogEnabled: false,
      backlogTaskIds: [],
    });
    db.close();
  });
});
