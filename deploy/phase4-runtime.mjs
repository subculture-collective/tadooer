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

const baseUrl = process.argv[2];
if (baseUrl === undefined) throw new Error("Suite base URL is required");

const request = (path, init = {}) =>
  globalThis.fetch(`${baseUrl}${path}`, init);
const setup = await request("/api/setup", {
  method: "POST",
  headers: { Origin: baseUrl, "Content-Type": "application/json" },
  body: JSON.stringify({
    username: "phase4-owner",
    displayName: "Phase 4 Owner",
    password: "correct horse battery staple",
  }),
});
if (setup.status !== 201)
  throw new Error(`Setup failed: ${String(setup.status)}`);
const login = await request("/api/auth/login", {
  method: "POST",
  headers: { Origin: baseUrl, "Content-Type": "application/json" },
  body: JSON.stringify({
    username: "phase4-owner",
    password: "correct horse battery staple",
  }),
});
if (!login.ok) throw new Error("Login failed");
const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
const session = await login.json();
const issued = await request("/api/automation/tokens", {
  method: "POST",
  headers: {
    Origin: baseUrl,
    Cookie: cookie,
    "X-CSRF-Token": session.csrfToken,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    label: "Phase 4 runtime",
    scopes: ["tasks:read", "tasks:write"],
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }),
});
if (issued.status !== 201) throw new Error("Token issue failed");
const credential = await issued.json();

const directory = await mkdtemp(join(tmpdir(), "suite-phase4-"));
process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
const tokenFile = join(directory, "token");
await writeFile(tokenFile, `${credential.token}\n`, { mode: 0o600 });

const run = (script, arguments_) =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [resolve(script), ...arguments_], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", rejectRun);
    child.on("close", (code) =>
      code === 0
        ? resolveRun(stdout)
        : rejectRun(new Error(`Client failed (${String(code)}): ${stderr}`)),
    );
  });

const quickArguments = [
  "--url",
  baseUrl,
  "--token-file",
  tokenFile,
  "--idempotency-key",
  "phase4-runtime-quick-add",
  "Qualified quick add",
];
const first = JSON.parse(
  await run("apps/quick-add/dist/main.mjs", quickArguments),
);
const replay = JSON.parse(
  await run("apps/quick-add/dist/main.mjs", quickArguments),
);
if (first.result.task.id !== replay.result.task.id || replay.replayed !== true)
  throw new Error("Quick-add retry was not replay-safe");

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
    params: { uri: "suite://v1/tasks" },
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
  !responses[1]?.result?.tools?.some(
    ({ name }) => name === "suite.tasks.create",
  )
)
  throw new Error("MCP catalog did not expose Suite task creation");
if (!JSON.stringify(responses[2]).includes("Qualified quick add"))
  throw new Error("MCP task resource did not observe quick-add result");

const revoked = await request(
  `/api/automation/tokens/${credential.record.id}`,
  {
    method: "DELETE",
    headers: {
      Origin: baseUrl,
      Cookie: cookie,
      "X-CSRF-Token": session.csrfToken,
    },
  },
);
if (revoked.status !== 204) throw new Error("Token revocation failed");
const denied = await request("/api/automation/v1/resources/tasks", {
  headers: { Authorization: `Bearer ${credential.token}` },
});
if (denied.status !== 401) throw new Error("Revoked token did not fail closed");
const browser = await request("/api/tasks", { headers: { Cookie: cookie } });
if (!browser.ok) throw new Error("Token revocation disrupted browser session");

await rm(directory, { recursive: true, force: true });
console.log(
  "Phase 4 deployed quick-add, stdio MCP, retry, revocation, and browser continuity verified",
);
