import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import console from "node:console";
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
const browserHeaders = (cookie, csrf, body = true) => ({
  Origin: baseUrl,
  Cookie: cookie,
  "X-CSRF-Token": csrf,
  ...(body ? { "Content-Type": "application/json" } : {}),
});
const command = (file, args) =>
  new Promise((resolveCommand, rejectCommand) =>
    execFile(
      file,
      args,
      { env: { ...process.env, COMPOSE_PROJECT_NAME: projectName } },
      (error, stdout, stderr) =>
        error === null
          ? resolveCommand(stdout)
          : rejectCommand(new Error(`${file} failed: ${stderr}`)),
    ),
  );

const setup = await request("/api/setup", {
  method: "POST",
  headers: { Origin: baseUrl, "Content-Type": "application/json" },
  body: JSON.stringify({
    username: "phase6-owner",
    displayName: "Phase 6 Owner",
    password: "correct horse battery staple",
  }),
});
if (setup.status !== 201) throw new Error(`Setup failed: ${setup.status}`);
const login = await request("/api/auth/login", {
  method: "POST",
  headers: { Origin: baseUrl, "Content-Type": "application/json" },
  body: JSON.stringify({
    username: "phase6-owner",
    password: "correct horse battery staple",
  }),
});
if (!login.ok) throw new Error("Login failed");
const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
const session = await login.json();
const parentResponse = await request("/api/tasks", {
  method: "POST",
  headers: {
    ...browserHeaders(cookie, session.csrfToken),
    "Idempotency-Key": "phase6-runtime-parent",
  },
  body: JSON.stringify({ title: "Runtime leg day", notes: "" }),
});
if (parentResponse.status !== 201)
  throw new Error("Parent task creation failed");
const parent = await parentResponse.json();
const poolResponse = await request("/api/pools", {
  method: "POST",
  headers: browserHeaders(cookie, session.csrfToken),
  body: JSON.stringify({
    title: "Runtime exercise rotation",
    policy: "cycle",
    pickCount: 2,
    cooldownSeconds: null,
    items: [
      { title: "Squat" },
      { title: "Lunge" },
      { title: "Calf raise" },
      { title: "Leg curl" },
    ],
  }),
});
if (poolResponse.status !== 201) throw new Error("Pool creation failed");
const pool = await poolResponse.json();
const placeholderResponse = await request("/api/placeholders", {
  method: "POST",
  headers: browserHeaders(cookie, session.csrfToken),
  body: JSON.stringify({ taskId: parent.task.id, poolId: pool.pool.id }),
});
if (placeholderResponse.status !== 201)
  throw new Error("Placeholder creation failed");
const placeholder = await placeholderResponse.json();
const logicalTime = "2026-08-07T12:00:00.000Z";
const suggestionResponse = await request(
  `/api/placeholders/${placeholder.id}/suggestion?at=${encodeURIComponent(logicalTime)}`,
  { headers: { Cookie: cookie } },
);
const suggestion = await suggestionResponse.json();
if (!suggestionResponse.ok || suggestion.selectedItemIds.length !== 2)
  throw new Error("Pool suggestion did not return two eligible unique items");
const subtasksBefore = await request(`/api/tasks/${parent.task.id}/subtasks`, {
  headers: { Cookie: cookie },
});
if ((await subtasksBefore.json()).subtasks.length !== 0)
  throw new Error("Suggestion mutated the placeholder parent");

const issued = await request("/api/automation/tokens", {
  method: "POST",
  headers: browserHeaders(cookie, session.csrfToken),
  body: JSON.stringify({
    label: "Phase 6 runtime",
    scopes: ["pools:read", "pools:write"],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  }),
});
if (issued.status !== 201)
  throw new Error("Automation credential issue failed");
const credential = await issued.json();
const directory = await mkdtemp(join(tmpdir(), "suite-phase6-"));
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
    params: { uri: "suite://v1/pools" },
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
if (
  !responses
    .find(({ id }) => id === 2)
    ?.result?.tools?.some(({ name }) => name === "suite.placeholders.resolve")
)
  throw new Error("MCP catalog omitted placeholder resolution");
if (
  !JSON.stringify(responses.find(({ id }) => id === 3)).includes(pool.pool.id)
)
  throw new Error("MCP pool resource omitted the Choice Pool");

const previewResponse = await request("/api/automation/v1/previews", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${credential.token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    operation: "placeholders.resolve",
    input: {
      placeholderId: placeholder.id,
      selectedItemIds: suggestion.selectedItemIds,
      logicalTime,
      override: false,
      expectedRevision: 1,
    },
  }),
});
if (previewResponse.status !== 201)
  throw new Error("Resolution preview failed");
const preview = (await previewResponse.json()).preview;
const confirmation = () =>
  request(`/api/automation/v1/previews/${preview.id}/confirm`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ idempotencyKey: "phase6-runtime-resolution" }),
  });
const first = await confirmation();
if (!first.ok) throw new Error("Resolution confirmation failed");
const firstBody = await first.json();
if (
  firstBody.result.subtasks.length !== 2 ||
  firstBody.result.history.length !== 2
)
  throw new Error("Resolution did not atomically create work and history");
await command("docker", ["compose", "restart", "suite"]);
await command("docker", ["compose", "up", "-d", "--wait", "suite"]);
const replay = await confirmation();
const replayBody = await replay.json();
if (
  !replay.ok ||
  !replayBody.replayed ||
  replayBody.result.resolution.id !== firstBody.result.resolution.id
)
  throw new Error("Restart retry did not replay the exact resolution");
const backupOutput = await command("./deploy/backup.sh", []);
const backup = /\/([^/\s]+\.sqlite)(?:\s|$)/.exec(backupOutput)?.[1];
if (backup === undefined) throw new Error("Backup did not report its database");
await command("./deploy/restore.sh", [backup]);
const restored = await request("/api/automation/v1/resources/pools", {
  headers: { Authorization: `Bearer ${credential.token}` },
});
const restoredBody = await restored.json();
if (
  !restored.ok ||
  !restoredBody.history?.some(
    ({ id }) => id === firstBody.result.history[0].id,
  ) ||
  restoredBody.placeholders?.filter(({ id }) => id === placeholder.id)
    .length !== 1
)
  throw new Error("Pool history or placeholder was not restored");
const restoredReplay = await confirmation();
const restoredReplayBody = await restoredReplay.json();
if (
  !restoredReplay.ok ||
  restoredReplayBody.result.resolution.id !== firstBody.result.resolution.id
)
  throw new Error("Restored resolution did not replay exact identities");
await rm(directory, { recursive: true, force: true });
console.log(
  "Phase 6 deployed explainable pool resolution, restart replay, and backup/restore verified",
);
