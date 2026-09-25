import { join } from "node:path";
import { expect, it } from "vitest";
import { withTemporaryDirectory } from "@suite/test-support";
import { SuiteDatabase } from "./index.ts";

const now = "2026-09-24T12:00:00.000Z";
const later = "2026-09-24T13:00:00.000Z";
const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const ids = {
  a: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  b: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  c: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

const importedTask = {
  kind: "task" as const,
  sourceId: "sp-task",
  sourceHash: "hash-1",
  sourceJson: '{"issueId":"42"}',
  title: "Imported with links",
  notes: "",
  projectId: null,
  tagIds: [],
  plannedStart: null,
  deadlineDate: null,
  deadlineAt: null,
  estimateMinutes: null,
  completedAt: null,
  createdAt: null,
  issueLink: {
    providerKey: "GITEA",
    providerSourceId: "removed-provider",
    providerRecorded: false,
    issueId: "42",
    displayUrl: null,
    lastUpdatedAt: now,
    syncMetadata: { issueWasUpdated: true },
  },
  attachments: [
    {
      kind: "link" as const,
      title: "Spec",
      url: "https://example.test/spec",
      text: null,
      sourcePath: null,
      unavailableReason: null,
    },
    {
      kind: "file" as const,
      title: "Draft",
      url: null,
      text: null,
      sourcePath: "/home/me/draft.odt",
      unavailableReason: "device_local" as const,
    },
    {
      kind: "command" as const,
      title: "Build",
      url: null,
      text: null,
      sourcePath: "make release",
      unavailableReason: "command_not_run" as const,
    },
  ],
};

const open = (directory: string) => {
  const db = SuiteDatabase.open(join(directory, "db.sqlite"));
  return db;
};
const setup = (db: SuiteDatabase) => {
  for (const [id, username] of [
    [owner, "owner"],
    [other, "other"],
  ] as const)
    db.createOwner({
      id,
      username,
      displayName: username,
      passwordHash: "hash",
      createdAt: now,
    });
};

it("imports links and unavailable attachments once, across replay and restart", async () => {
  await withTemporaryDirectory((directory) => {
    let db = open(directory);
    setup(db);
    expect(db.importTaskRecords(owner, [importedTask], now)).toEqual({
      created: 1,
      existing: 0,
    });
    const taskId = db.listTasks(owner)[0]?.id ?? "";
    const links = db.taskLinks.get(owner, taskId);
    expect(links?.issueLink).toMatchObject({
      providerKey: "GITEA",
      providerSourceId: "removed-provider",
      providerRecorded: false,
      issueId: "42",
      connection: "authorization_required",
      lastUpdatedAt: now,
      syncMetadata: { issueWasUpdated: true },
      revision: 1,
    });
    expect(
      links?.attachments.map(({ kind, available, unavailableReason }) => ({
        kind,
        available,
        unavailableReason,
      })),
    ).toEqual([
      { kind: "link", available: true, unavailableReason: null },
      { kind: "file", available: false, unavailableReason: "device_local" },
      {
        kind: "command",
        available: false,
        unavailableReason: "command_not_run",
      },
    ]);
    // Replay creates nothing, even after a restart.
    db.close();
    db = open(directory);
    expect(db.importTaskRecords(owner, [importedTask], now)).toEqual({
      created: 0,
      existing: 1,
    });
    expect(db.taskLinks.get(owner, taskId)?.attachments).toHaveLength(3);
    expect(db.taskLinks.get(owner, taskId)?.issueLink?.issueId).toBe("42");
    db.close();
  });
});

it("scopes every read and write to the owner and task", async () => {
  await withTemporaryDirectory((directory) => {
    const db = open(directory);
    setup(db);
    db.importTaskRecords(owner, [importedTask], now);
    const taskId = db.listTasks(owner)[0]?.id ?? "";
    const links = db.taskLinks.get(owner, taskId);
    const attachment = links?.attachments[0];
    const issue = links?.issueLink;
    if (attachment === undefined || issue == null) throw new Error("setup");
    expect(db.taskLinks.get(other, taskId)).toBeUndefined();
    expect(db.taskLinks.getAttachment(other, attachment.id)).toBeUndefined();
    expect(db.taskLinks.getIssueLink(other, issue.id)).toBeUndefined();
    expect(
      db.taskLinks.createAttachment(
        other,
        taskId,
        ids.a,
        { kind: "note", title: "", text: "intrusion" },
        now,
      ).kind,
    ).toBe("not_found");
    expect(
      db.taskLinks.updateAttachment(
        other,
        attachment.id,
        1,
        { title: "x" },
        now,
      ).kind,
    ).toBe("not_found");
    expect(db.taskLinks.deleteAttachment(other, attachment.id, 1).kind).toBe(
      "not_found",
    );
    expect(db.taskLinks.deleteIssueLink(other, issue.id, 1).kind).toBe(
      "not_found",
    );
    expect(db.taskLinks.get(owner, taskId)?.attachments).toHaveLength(3);
    expect(db.taskLinks.get(owner, taskId)?.issueLink).not.toBeNull();
    db.close();
  });
});

it("creates, edits and removes attachments with revisions and safe addresses", async () => {
  await withTemporaryDirectory((directory) => {
    const db = open(directory);
    setup(db);
    db.importTaskRecords(owner, [importedTask], now);
    const taskId = db.listTasks(owner)[0]?.id ?? "";
    for (const url of [
      "javascript:alert(1)",
      "https://user:secret@example.test/",
      "file:///etc/passwd",
      "/relative",
    ])
      expect(
        db.taskLinks.createAttachment(
          owner,
          taskId,
          ids.a,
          { kind: "link", title: "", url },
          now,
        ).kind,
      ).toBe("invalid");
    const created = db.taskLinks.createAttachment(
      owner,
      taskId,
      ids.a,
      { kind: "link", title: " Board ", url: "https://example.test/board" },
      now,
    );
    if (created.kind !== "applied") throw new Error(created.kind);
    const link = created.links.attachments.find(({ id }) => id === ids.a);
    expect(link).toMatchObject({
      title: "Board",
      source: "suite",
      position: 3,
      revision: 1,
    });
    // Duplicate IDs conflict.
    expect(
      db.taskLinks.createAttachment(
        owner,
        taskId,
        ids.a,
        { kind: "note", title: "", text: "dup" },
        now,
      ).kind,
    ).toBe("conflict");
    // Stale revisions conflict; kind-specific fields are enforced.
    expect(
      db.taskLinks.updateAttachment(owner, ids.a, 2, { title: "x" }, later)
        .kind,
    ).toBe("conflict");
    expect(
      db.taskLinks.updateAttachment(owner, ids.a, 1, { text: "x" }, later).kind,
    ).toBe("invalid");
    const edited = db.taskLinks.updateAttachment(
      owner,
      ids.a,
      1,
      { url: "https://example.test/board/2" },
      later,
    );
    expect(
      edited.kind === "applied"
        ? edited.links.attachments.find(({ id }) => id === ids.a)
        : undefined,
    ).toMatchObject({
      url: "https://example.test/board/2",
      revision: 2,
      updatedAt: later,
    });
    // Unavailable provenance cannot gain an address.
    const file = db.taskLinks
      .get(owner, taskId)
      ?.attachments.find(({ kind }) => kind === "file");
    if (file === undefined) throw new Error("file");
    expect(
      db.taskLinks.updateAttachment(
        owner,
        file.id,
        1,
        { url: "https://example.test" },
        later,
      ).kind,
    ).toBe("invalid");
    expect(db.taskLinks.deleteAttachment(owner, ids.a, 1).kind).toBe(
      "conflict",
    );
    expect(db.taskLinks.deleteAttachment(owner, ids.a, 2).kind).toBe("applied");
    const issue = db.taskLinks.get(owner, taskId)?.issueLink;
    if (issue == null) throw new Error("issue");
    expect(db.taskLinks.deleteIssueLink(owner, issue.id, 2).kind).toBe(
      "conflict",
    );
    expect(db.taskLinks.deleteIssueLink(owner, issue.id, 1).kind).toBe(
      "applied",
    );
    expect(db.taskLinks.get(owner, taskId)?.issueLink).toBeNull();
    db.close();
  });
});

it("keeps links readable on deleted tasks but rejects writes until restore", async () => {
  await withTemporaryDirectory((directory) => {
    const db = open(directory);
    setup(db);
    db.importTaskRecords(owner, [importedTask], now);
    const task = db.listTasks(owner)[0];
    if (task === undefined) throw new Error("task");
    db.deleteTask(owner, task.id, task.revision, now);
    expect(db.taskLinks.get(owner, task.id)?.attachments).toHaveLength(3);
    expect(
      db.taskLinks.createAttachment(
        owner,
        task.id,
        ids.b,
        { kind: "note", title: "", text: "later" },
        now,
      ).kind,
    ).toBe("not_found");
    db.close();
  });
});

it("limits a task to 100 attachments", async () => {
  await withTemporaryDirectory((directory) => {
    const db = open(directory);
    setup(db);
    db.importTaskRecords(
      owner,
      [
        {
          ...importedTask,
          issueLink: null,
          attachments: Array.from({ length: 100 }, () => ({
            kind: "note" as const,
            title: "",
            url: null,
            text: "n",
            sourcePath: null,
            unavailableReason: null,
          })),
        },
      ],
      now,
    );
    const taskId = db.listTasks(owner)[0]?.id ?? "";
    expect(
      db.taskLinks.createAttachment(
        owner,
        taskId,
        ids.c,
        { kind: "note", title: "", text: "one more" },
        now,
      ).kind,
    ).toBe("invalid");
    db.close();
  });
});
