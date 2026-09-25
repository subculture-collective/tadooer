import { expect, it } from "vitest";
import { prepareSuperProductivityImport } from "./super-productivity-apply.ts";

const state = (entities: Record<string, unknown>) => ({
  ids: Object.keys(entities),
  entities,
});
const secretToken = "gitea-token-do-not-store";
const providers = state({
  gitea: {
    id: "gitea",
    issueProviderKey: "GITEA",
    isEnabled: true,
    pluginId: "gitea-issue-provider",
    pluginConfig: {
      host: "https://git.example.test/",
      repoFullname: "owner/repo",
      token: secretToken,
    },
  },
  calendar: {
    id: "calendar",
    issueProviderKey: "ICAL",
    isEnabled: true,
    icalUrl: "https://calendar.example.test/private-secret-feed.ics",
  },
});
const prepare = (
  tasks: Record<string, Record<string, unknown>>,
  extra: Record<string, unknown> = { issueProvider: providers },
) =>
  prepareSuperProductivityImport(
    JSON.stringify({
      task: state(
        Object.fromEntries(
          Object.entries(tasks).map(([id, task]) => [
            id,
            { id, title: `Task ${id}`, ...task },
          ]),
        ),
      ),
      ...extra,
    }),
  );
const task = (result: ReturnType<typeof prepare>, sourceId: string) => {
  const record = result.records.find((item) => item.sourceId === sourceId);
  if (record === undefined) throw new Error(`missing ${sourceId}`);
  return record;
};

it("maps linked issues with provider identity and never reads provider credentials", () => {
  const result = prepare({
    g: {
      issueId: "42",
      issueProviderId: "gitea",
      issueType: "GITEA",
      issueWasUpdated: false,
      issueLastUpdated: 1700000000000,
      issueAttachmentNr: 2,
      issueLastSyncedValues: { title: "Remote title" },
    },
    c: {
      issueId: "uid-123@calendar.example.test",
      issueProviderId: "calendar",
      issueType: "ICAL",
      issueWasUpdated: true,
    },
  });
  expect(result.report.canApply).toBe(true);
  expect(task(result, "g").issueLink).toEqual({
    providerKey: "GITEA",
    providerSourceId: "gitea",
    providerRecorded: true,
    issueId: "42",
    displayUrl: "https://git.example.test/owner/repo/issues/42",
    lastUpdatedAt: new Date(1700000000000).toISOString(),
    syncMetadata: {
      issueLastUpdated: 1700000000000,
      issueAttachmentNr: 2,
      issueLastSyncedValues: { title: "Remote title" },
    },
  });
  // A calendar feed address can be a capability secret: no URL is derived.
  expect(task(result, "c").issueLink).toMatchObject({
    providerKey: "ICAL",
    displayUrl: null,
    syncMetadata: { issueWasUpdated: true },
  });
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain(secretToken);
  expect(serialized).not.toContain("private-secret-feed");
});

it("keeps links to providers missing from the export and reports them without blocking", () => {
  const result = prepare({
    removed: { issueId: "7", issueProviderId: "deleted", issueType: "GITEA" },
    legacy: { issueId: "8" },
  });
  expect(result.report.canApply).toBe(true);
  expect(task(result, "removed").issueLink).toMatchObject({
    providerKey: "GITEA",
    providerSourceId: "deleted",
    providerRecorded: false,
    displayUrl: null,
  });
  expect(task(result, "legacy").issueLink).toMatchObject({
    providerKey: null,
    providerSourceId: null,
    providerRecorded: false,
  });
  expect(
    result.report.issues.filter(
      ({ code }) => code === "issue_provider_missing",
    ),
  ).toHaveLength(2);
});

it("maps every attachment type; local files and commands stay inert provenance", () => {
  const result = prepare({
    a: {
      attachments: [
        {
          id: "1",
          type: "LINK",
          title: "Spec",
          path: "https://example.test/spec?x=1",
        },
        {
          id: "2",
          type: "LINK",
          title: "Pasted",
          path: "//example.test/pasted",
        },
        {
          id: "3",
          type: "IMG",
          title: "Web image",
          path: "https://example.test/i.png",
        },
        {
          id: "4",
          type: "IMG",
          title: "Local image",
          path: "/home/me/i.png",
          originalImgPath: "/home/me/i.png",
        },
        {
          id: "5",
          type: "FILE",
          title: "Draft",
          path: "/home/me/draft.odt",
          icon: "insert_drive_file",
        },
        { id: "6", type: "COMMAND", title: "Build", path: "rm -rf /tmp/x" },
        { id: "7", type: "NOTE", title: "Reminder", path: "Bring the charger" },
        { id: "8", type: "LINK", title: "Script", path: "javascript:alert(1)" },
      ],
    },
  });
  expect(result.report.canApply).toBe(true);
  expect(task(result, "a").attachments).toEqual([
    {
      kind: "link",
      title: "Spec",
      url: "https://example.test/spec?x=1",
      text: null,
      sourcePath: null,
      unavailableReason: null,
    },
    {
      kind: "link",
      title: "Pasted",
      url: "https://example.test/pasted",
      text: null,
      sourcePath: null,
      unavailableReason: null,
    },
    {
      kind: "image",
      title: "Web image",
      url: "https://example.test/i.png",
      text: null,
      sourcePath: null,
      unavailableReason: null,
    },
    {
      kind: "image",
      title: "Local image",
      url: null,
      text: null,
      sourcePath: "/home/me/i.png",
      unavailableReason: "device_local",
    },
    {
      kind: "file",
      title: "Draft",
      url: null,
      text: null,
      sourcePath: "/home/me/draft.odt",
      unavailableReason: "device_local",
    },
    {
      kind: "command",
      title: "Build",
      url: null,
      text: null,
      sourcePath: "rm -rf /tmp/x",
      unavailableReason: "command_not_run",
    },
    {
      kind: "note",
      title: "Reminder",
      url: null,
      text: "Bring the charger",
      sourcePath: null,
      unavailableReason: null,
    },
    {
      kind: "link",
      title: "Script",
      url: null,
      text: null,
      sourcePath: "javascript:alert(1)",
      unavailableReason: "unsupported_address",
    },
  ]);
  // The complete source attachment list, including icon and originalImgPath,
  // stays recoverable in the task provenance.
  const provenance = JSON.parse(task(result, "a").sourceJson) as {
    attachments: { originalImgPath?: string; icon?: string }[];
  };
  expect(provenance.attachments).toHaveLength(8);
  expect(provenance.attachments[3]?.originalImgPath).toBe("/home/me/i.png");
  expect(provenance.attachments[4]?.icon).toBe("insert_drive_file");
});

it("blocks unreviewed, malformed or credential-bearing attachments with content-safe diagnostics", () => {
  const credential = "https://user:hunter2@example.test/private";
  for (const attachments of [
    [{ type: "LINK", path: "https://example.test", surprise: true }],
    [{ type: "VIDEO", path: "https://example.test" }],
    [{ type: "LINK" }],
    [{ type: "LINK", path: credential }],
    [{ type: "LINK", path: "//user:hunter2@example.test/private" }],
    "not a list",
    Array.from({ length: 101 }, () => ({ type: "NOTE", path: "x" })),
  ]) {
    const result = prepare({ t: { attachments } });
    expect(
      result.report.canApply,
      JSON.stringify(attachments).slice(0, 80),
    ).toBe(false);
    expect(JSON.stringify(result.report.issues)).not.toContain("hunter2");
    expect(JSON.stringify(result.report.issues)).not.toContain("example.test");
  }
});

it("blocks unidentifiable or inconsistent issue fields without echoing them", () => {
  for (const fields of [
    { issueProviderId: "gitea" },
    { issueId: 42 },
    { issueId: "1", issueType: "not a key!" },
    { issueId: "1", issueProviderId: "gitea", issueType: "ICAL" },
    { issueId: "1", issueLastUpdated: "yesterday" },
    { issueId: "1", issueLastSyncedValues: { body: "x".repeat(70_000) } },
  ]) {
    const result = prepare({ t: fields });
    expect(result.report.canApply, JSON.stringify(fields).slice(0, 80)).toBe(
      false,
    );
    expect(JSON.stringify(result.report.issues)).not.toContain(
      "git.example.test",
    );
  }
});

it("keeps provenance hashes of tasks without links unchanged", () => {
  const plain = prepare({ t: {} }, {});
  const withDefaults = prepare(
    {
      t: {
        attachments: [],
        issueId: null,
        issueProviderId: null,
        issueType: null,
        issueWasUpdated: false,
        issueLastUpdated: null,
        issuePoints: null,
        issueTimeTracked: null,
        issueLastSyncedValues: {},
      },
    },
    {},
  );
  expect(withDefaults.report.canApply).toBe(true);
  expect(task(withDefaults, "t").sourceHash).toBe(task(plain, "t").sourceHash);
  expect(task(withDefaults, "t").issueLink).toBeUndefined();
  expect(task(withDefaults, "t").attachments).toBeUndefined();
});
