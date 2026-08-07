import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import console from "node:console";
import { rmSync } from "node:fs";
import {
  clearInterval,
  clearTimeout,
  setInterval,
  setTimeout,
} from "node:timers";

const [baseUrl, projectName] = process.argv.slice(2);
if (baseUrl === undefined || projectName === undefined)
  throw new Error("Suite base URL and Compose project name are required");

const request = (path, init = {}) =>
  globalThis.fetch(`${baseUrl}${path}`, init);
const browserHeaders = (cookie, csrfToken, body = true) => ({
  Origin: baseUrl,
  Cookie: cookie,
  "X-CSRF-Token": csrfToken,
  ...(body ? { "Content-Type": "application/json" } : {}),
});
const command = (file, args) =>
  new Promise((resolveCommand, rejectCommand) => {
    execFile(
      file,
      args,
      { env: { ...process.env, COMPOSE_PROJECT_NAME: projectName } },
      (error, stdout, stderr) =>
        error === null
          ? resolveCommand(stdout)
          : rejectCommand(new Error(`${file} failed: ${stderr}`)),
    );
  });

const setup = await request("/api/setup", {
  method: "POST",
  headers: { Origin: baseUrl, "Content-Type": "application/json" },
  body: JSON.stringify({
    username: "phase5-owner",
    displayName: "Phase 5 Owner",
    password: "correct horse battery staple",
  }),
});
if (setup.status !== 201)
  throw new Error(`Setup failed: ${String(setup.status)}`);
const login = await request("/api/auth/login", {
  method: "POST",
  headers: { Origin: baseUrl, "Content-Type": "application/json" },
  body: JSON.stringify({
    username: "phase5-owner",
    password: "correct horse battery staple",
  }),
});
if (!login.ok) throw new Error("Login failed");
const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
const session = await login.json();

const projectResponse = await request("/api/projects", {
  method: "POST",
  headers: browserHeaders(cookie, session.csrfToken),
  body: JSON.stringify({ title: "Phase 5 destination" }),
});
if (projectResponse.status !== 201) throw new Error("Project creation failed");
const project = await projectResponse.json();

const templateResponse = await request("/api/templates", {
  method: "POST",
  headers: browserHeaders(cookie, session.csrfToken),
  body: JSON.stringify({
    title: "Qualified reusable work",
    notes: "This must remain an inert blueprint.",
    estimateMinutes: 45,
    suggestedProjectId: project.project.id,
    tagIds: [],
    subtasks: [
      { title: "First independent step" },
      { title: "Second independent step" },
    ],
  }),
});
if (templateResponse.status !== 201)
  throw new Error("Template creation failed");
const template = await templateResponse.json();

const setResponse = await request("/api/template-sets", {
  method: "POST",
  headers: browserHeaders(cookie, session.csrfToken),
  body: JSON.stringify({ title: "Qualified set", templateIds: [template.id] }),
});
if (setResponse.status !== 201) throw new Error("Template Set creation failed");
await setResponse.json();

const tasksBefore = await request("/api/tasks", {
  headers: { Cookie: cookie },
});
if (!tasksBefore.ok || (await tasksBefore.json()).tasks.length !== 0)
  throw new Error("Inert template appeared in the ordinary task list");
const plannerBefore = await request(
  "/api/planner?from=2026-08-06T00%3A00%3A00.000Z&to=2026-08-07T00%3A00%3A00.000Z",
  { headers: { Cookie: cookie } },
);
if (!plannerBefore.ok || (await plannerBefore.json()).tasks.length !== 0)
  throw new Error("Inert template appeared in the planner");

const issued = await request("/api/automation/tokens", {
  method: "POST",
  headers: browserHeaders(cookie, session.csrfToken),
  body: JSON.stringify({
    label: "Phase 5 runtime",
    scopes: ["tasks:read", "templates:read", "templates:write"],
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }),
});
if (issued.status !== 201)
  throw new Error("Automation credential issue failed");
const credential = await issued.json();
const directory = await mkdtemp(join(tmpdir(), "suite-phase5-"));
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
const tokenFile = join(directory, "token");
await writeFile(tokenFile, `${credential.token}\n`, { mode: 0o600 });

const mcp = spawn(
  process.execPath,
  [
    resolve("apps/mcp-stdio/dist/main.mjs"),
    "--url",
    baseUrl,
    "--token-file",
    tokenFile,
  ],
  { stdio: ["pipe", "pipe", "pipe"] },
);
const responses = [];
let pending = "";
mcp.stdout.setEncoding("utf8").on("data", (chunk) => {
  pending += chunk;
  const lines = pending.split("\n");
  pending = lines.pop() ?? "";
  for (const line of lines) if (line !== "") responses.push(JSON.parse(line));
});
for (const message of [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  {
    jsonrpc: "2.0",
    id: 3,
    method: "resources/read",
    params: { uri: "suite://v1/templates" },
  },
])
  mcp.stdin.write(`${JSON.stringify(message)}\n`);
await new Promise((resolveWait, rejectWait) => {
  const deadline = setTimeout(
    () => rejectWait(new Error("MCP response timeout")),
    10_000,
  );
  const timer = setInterval(() => {
    if (responses.length >= 3) {
      clearTimeout(deadline);
      clearInterval(timer);
      resolveWait();
    }
  }, 20);
});
mcp.stdin.end();
const toolsResponse = responses.find(({ id }) => id === 2);
const templatesResponse = responses.find(({ id }) => id === 3);
if (
  !toolsResponse?.result?.tools?.some(
    ({ name }) => name === "suite.templates.instantiate",
  )
)
  throw new Error("MCP catalog did not expose template instantiation");
if (!JSON.stringify(templatesResponse).includes("Qualified reusable work"))
  throw new Error(
    `MCP template resource did not expose the template: ${JSON.stringify(templatesResponse)}`,
  );

const previewResponse = await request("/api/automation/v1/previews", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${credential.token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    operation: "templates.instantiate",
    input: {
      templateId: template.id,
      destinationProjectId: project.project.id,
    },
  }),
});
if (previewResponse.status !== 201)
  throw new Error("Template instantiation preview failed");
const preview = (await previewResponse.json()).preview;
const beforeConfirm = await request("/api/tasks", {
  headers: { Cookie: cookie },
});
if ((await beforeConfirm.json()).tasks.length !== 0)
  throw new Error("Template preview created a task");
const confirmation = async () =>
  request(`/api/automation/v1/previews/${preview.id}/confirm`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ idempotencyKey: "phase5-template-tree-001" }),
  });
const first = await confirmation();
if (!first.ok) throw new Error("Template confirmation failed");
const firstBody = await first.json();
if (firstBody.result.tasks?.[0]?.subtasks?.length !== 2)
  throw new Error("Confirmation did not create the complete subtask tree");
const replay = await confirmation();
if (!replay.ok || (await replay.json()).replayed !== true)
  throw new Error("Template confirmation retry was not replay-safe");

const backupOutput = await command("./deploy/backup.sh", []);
const backup = /\/([^/\s]+\.sqlite)(?:\s|$)/.exec(backupOutput)?.[1];
if (backup === undefined)
  throw new Error("Suite backup did not report a database basename");
await command("./deploy/restore.sh", [backup]);
const restoredTemplates = await request("/api/templates", {
  headers: { Cookie: cookie },
});
if (
  !restoredTemplates.ok ||
  !JSON.stringify(await restoredTemplates.json()).includes(template.id)
)
  throw new Error("Template data was not preserved by restore");
const restoredTasks = await request("/api/tasks", {
  headers: { Cookie: cookie },
});
const restoredTaskBody = await restoredTasks.json();
if (
  !restoredTasks.ok ||
  !restoredTaskBody.tasks.some(
    ({ id }) => id === firstBody.result.tasks[0].task.id,
  )
)
  throw new Error(
    "Instantiated task provenance target was not preserved by restore",
  );
const restoredReplay = await confirmation();
const restoredReplayBody = await restoredReplay.json();
if (
  !restoredReplay.ok ||
  restoredReplayBody.replayed !== true ||
  restoredReplayBody.result.tasks[0].task.id !==
    firstBody.result.tasks[0].task.id ||
  restoredTaskBody.tasks.length !== 1
)
  throw new Error(
    "Restored confirmation outcome did not replay the exact original task tree",
  );

const revoked = await request(
  `/api/automation/tokens/${credential.record.id}`,
  {
    method: "DELETE",
    headers: browserHeaders(cookie, session.csrfToken, false),
  },
);
if (revoked.status !== 204) throw new Error("Credential revocation failed");
const denied = await request("/api/automation/v1/resources/templates", {
  headers: { Authorization: `Bearer ${credential.token}` },
});
if (denied.status !== 401)
  throw new Error("Revoked credential did not fail closed");
if (!(await request("/api/tasks", { headers: { Cookie: cookie } })).ok)
  throw new Error("Revocation disrupted browser access");
await rm(directory, { recursive: true, force: true });
console.log(
  "Phase 5 deployed inert template, MCP confirmation/retry, and backup/restore verified",
);
