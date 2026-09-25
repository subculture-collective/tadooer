import { join } from "node:path";
import { expect, it } from "vitest";
import { prepareSuperProductivityImport } from "@suite/import-export";
import { SuiteDatabase } from "@suite/persistence";
import { withTemporaryDirectory } from "@suite/test-support";

const now = "2026-09-24T12:00:00.000Z";
const store = (entities: Record<string, unknown>) => ({
  ids: Object.keys(entities),
  entities,
});

// Hierarchy (#27), organization (#28) and date-only planning (#29) share one
// import transaction; this checks the combination the separate slices never saw.
it("imports a planned child task inside a project backlog in one transaction", async () => {
  const { report, records } = prepareSuperProductivityImport(
    JSON.stringify({
      task: store({
        parent: {
          id: "parent",
          title: "Parent",
          projectId: "p",
          subTaskIds: ["child"],
          created: 1758000000000,
        },
        child: {
          id: "child",
          title: "Child",
          parentId: "parent",
          projectId: "p",
          dueDay: "2026-09-25",
          created: 1758000000000,
        },
      }),
      project: store({
        p: {
          id: "p",
          title: "Project",
          isEnableBacklog: true,
          backlogTaskIds: ["child"],
        },
      }),
      tag: store({}),
    }),
  );
  expect(
    report.issues.filter(({ code }) => code !== "configuration_not_imported"),
  ).toEqual([]);
  expect(report.canApply).toBe(true);

  await withTemporaryDirectory((directory) => {
    const path = join(directory, "db.sqlite");
    let db = SuiteDatabase.open(path);
    db.createOwner({
      id: "owner",
      username: "owner",
      displayName: "Owner",
      passwordHash: "hash",
      createdAt: now,
    });
    expect(db.importTaskRecords("owner", records, now)).toMatchObject({
      created: records.length,
    });
    const check = () => {
      const tasks = db.listTasks("owner");
      const parent = tasks.find((task) => task.title === "Parent");
      const child = tasks.find((task) => task.title === "Child");
      const project = db.listProjects("owner")[0];
      expect(child).toMatchObject({
        parentId: parent?.id,
        plannedDay: "2026-09-25",
        plannedStart: null,
        projectId: project?.id,
      });
      expect(project?.backlogTaskIds).toEqual([child?.id]);
    };
    check();
    db.close();
    db = SuiteDatabase.open(path);
    check();
    expect(db.importTaskRecords("owner", records, now)).toMatchObject({
      created: 0,
      existing: records.length,
    });
    check();
    db.close();
  });
});

// Linked data (#30) on archived history (#38): the link is kept on a read-only
// archived task and survives restart and replay.
it("keeps attachments on an imported archived task", async () => {
  const { report, records } = prepareSuperProductivityImport(
    JSON.stringify({
      task: store({}),
      archiveYoung: {
        task: store({
          done: {
            id: "done",
            title: "Done",
            isDone: true,
            doneOn: 1758000060000,
            created: 1758000000000,
            attachments: [
              {
                id: "a",
                type: "LINK",
                path: "https://example.com/spec",
                title: "Spec",
              },
            ],
          },
        }),
        timeTracking: { project: {}, tag: {} },
      },
      project: store({}),
      tag: store({}),
    }),
  );
  expect(report.issues.filter((issue) => issue.blocking)).toEqual([]);
  await withTemporaryDirectory((directory) => {
    const path = join(directory, "db.sqlite");
    let db = SuiteDatabase.open(path);
    db.createOwner({
      id: "owner",
      username: "owner",
      displayName: "Owner",
      passwordHash: "hash",
      createdAt: now,
    });
    db.importTaskRecords("owner", records, now);
    const check = () => {
      const archived = db.taskArchive.history({ ownerId: "owner" }).entries[0];
      expect(archived).toBeDefined();
      const links = db.taskLinks.get("owner", archived?.task.id ?? "");
      expect(links?.attachments.map(({ kind }) => kind)).toEqual(["link"]);
      expect(db.listTasks("owner")).toEqual([]);
    };
    check();
    db.close();
    db = SuiteDatabase.open(path);
    check();
    expect(db.importTaskRecords("owner", records, now)).toMatchObject({
      created: 0,
    });
    check();
    db.close();
  });
});
