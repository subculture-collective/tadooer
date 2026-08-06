import process from "node:process";
import { log } from "node:console";
import { readFileSync } from "node:fs";

const [mode, baseUrl] = process.argv.slice(2);

if (mode === "create") {
  const commonHeaders = {
    "Content-Type": "application/json",
    Origin: baseUrl,
  };
  const setup = await globalThis.fetch(`${baseUrl}/api/setup`, {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({
      username: "phase0-owner",
      displayName: "Phase 0 Owner",
      password: "synthetic phase zero verification passphrase",
    }),
  });
  if (setup.status !== 201) throw new Error(`setup failed: ${setup.status}`);

  const login = await globalThis.fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({
      username: "phase0-owner",
      password: "synthetic phase zero verification passphrase",
    }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  const session = await login.json();
  if (cookie === undefined || typeof session.csrfToken !== "string")
    throw new Error("login contract is incomplete");

  const taskResponse = await globalThis.fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: {
      ...commonHeaders,
      Cookie: cookie,
      "X-CSRF-Token": session.csrfToken,
      "Idempotency-Key": "compose-phase0-task-0001",
    },
    body: JSON.stringify({
      title: "Synthetic Phase 0 task",
      notes: "Disposable Compose verification only",
    }),
  });
  if (taskResponse.status !== 201)
    throw new Error(`task capture failed: ${taskResponse.status}`);
  const result = await taskResponse.json();
  if (result.replayed !== false || result.task?.revision !== 1)
    throw new Error("task mutation contract is invalid");
  log(JSON.stringify({ cookie, taskId: result.task.id }));
} else if (mode === "verify") {
  const state = JSON.parse(readFileSync(0, "utf8"));
  const response = await globalThis.fetch(`${baseUrl}/api/tasks`, {
    headers: { Cookie: state.cookie },
  });
  if (!response.ok) throw new Error(`task list failed: ${response.status}`);
  const result = await response.json();
  if (
    result.tasks?.length !== 1 ||
    result.tasks[0]?.id !== state.taskId ||
    result.tasks[0]?.revision !== 1
  ) {
    throw new Error("captured task identity did not persist");
  }
} else {
  throw new Error("expected create or verify mode");
}
