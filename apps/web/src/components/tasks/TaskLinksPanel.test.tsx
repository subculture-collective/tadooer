import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { taskLinksResponseSchema } from "@suite/contracts";
import { TaskLinksPanel, TaskLinksView } from "./TaskLinksPanel.tsx";

const ownerId = "5b7c3f1e-5d2a-4c2e-9d0e-1f2a3b4c5d6e";
const taskId = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const at = "2026-09-24T12:00:00.000Z";
const attachment = (
  id: string,
  fields: Record<string, unknown>,
): Record<string, unknown> => ({
  id,
  ownerId,
  taskId,
  title: "",
  url: null,
  text: null,
  sourcePath: null,
  available: true,
  unavailableReason: null,
  source: "super_productivity",
  position: 0,
  revision: 1,
  createdAt: at,
  updatedAt: at,
  ...fields,
});
const links = taskLinksResponseSchema.parse({
  taskId,
  issueLink: {
    id: "0e5d1a7f-3c2b-4a19-8e6d-2b3c4d5e6f70",
    ownerId,
    taskId,
    source: "super_productivity",
    providerKey: "GITEA",
    providerSourceId: "gitea",
    providerRecorded: true,
    issueId: "17",
    displayUrl: "https://git.test/team/app/issues/17",
    connection: "authorization_required",
    lastUpdatedAt: null,
    syncMetadata: {},
    revision: 1,
    createdAt: at,
    updatedAt: at,
  },
  attachments: [
    attachment("1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a51", {
      kind: "link",
      title: "Logs",
      url: "https://ci.test/run/9",
    }),
    attachment("1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a52", {
      kind: "command",
      title: "Rebuild",
      sourcePath: "make clean all",
      available: false,
      unavailableReason: "command_not_run",
    }),
    attachment("1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a53", {
      kind: "link",
      title: "Script",
      sourcePath: "javascript:alert(1)",
      available: false,
      unavailableReason: "unsupported_address",
    }),
    attachment("1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a54", {
      kind: "note",
      title: "Reminder",
      text: "Bring <b>the</b> charger",
    }),
  ],
});

const render = (online: boolean) =>
  renderToStaticMarkup(
    <TaskLinksView
      links={links}
      busy={false}
      online={online}
      onAdd={() => undefined}
      onRemoveAttachment={() => undefined}
      onRemoveIssueLink={() => undefined}
    />,
  );

it("opens only http(s) links in a new tab without opener access", () => {
  const html = render(true);
  expect(html).toContain(
    '<a href="https://git.test/team/app/issues/17" target="_blank" rel="noopener noreferrer">Issue 17</a>',
  );
  expect(html).toContain(
    '<a href="https://ci.test/run/9" target="_blank" rel="noopener noreferrer">Logs</a>',
  );
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain("Not connected");
});

it("shows unavailable provenance as inert text and escapes note content", () => {
  const html = render(true);
  expect(html).toContain("Tadooer never runs commands");
  expect(html).toContain("<code");
  expect(html).toContain("make clean all");
  expect(html).toContain("Bring &lt;b&gt;the&lt;/b&gt; charger");
});

it("disables every write offline", () => {
  const html = render(false);
  expect(html).toContain("Attachments need a connection to change");
  expect(html).not.toMatch(/<button(?![^>]*disabled)[^>]*>/);
  expect(
    renderToStaticMarkup(
      <TaskLinksPanel taskId={taskId} csrfToken="csrf" online={false} />,
    ),
  ).toContain("Links and attachments need a connection");
});
