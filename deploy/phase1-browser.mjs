#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { chromium, expect } from "@playwright/test";

const [mode, baseUrl, statePath] = process.argv.slice(2);
if (
  !["initial", "restart", "restore"].includes(mode) ||
  !baseUrl ||
  !statePath
) {
  throw new Error(
    "Usage: phase1-browser.mjs <initial|restart|restore> <base-url> <state-path>",
  );
}

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const ownerUsername = required("PHASE1_OWNER_USERNAME");
const ownerPassword = required("PHASE1_OWNER_PASSWORD");
const davUsername = required("BAIKAL_DAV_USERNAME");
const davPassword = required("BAIKAL_DAV_PASSWORD");
const baikalUrl = required("PHASE1_BAIKAL_URL");
const seedSummary = required("PHASE1_SEED_SUMMARY");
const storagePath = `${statePath}.storage.json`;
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/usr/bin/chromium";
const auth = `Basic ${Buffer.from(`${davUsername}:${davPassword}`).toString("base64")}`;

const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext(
  mode === "initial" ? {} : { storageState: storagePath },
);
const page = await context.newPage();

const taskItem = (title) =>
  page.locator(".task-view-group > .tasks > li").filter({
    has: page.locator(".task-heading > strong").filter({ hasText: title }),
  });
const openTasks = async () => {
  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Captured tasks" }),
  ).toBeVisible();
};
const openToday = async () => {
  await page.getByRole("link", { name: "Today", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Today", exact: true }),
  ).toBeVisible();
};
const localDateTime = (offsetHours) => {
  const date = new Date(Date.now() + offsetHours * 60 * 60 * 1000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};

const placeTask = async (title, start, expectedButton = "Schedule") => {
  const item = taskItem(title);
  await item.getByLabel("Start", { exact: true }).fill(start);
  await item.getByLabel("Minutes", { exact: true }).fill("45");
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().includes("/time-block") &&
        candidate.request().method() === "POST",
    ),
    item.getByRole("button", { name: expectedButton, exact: true }).click(),
  ]);
  return { response, body: await response.json() };
};

try {
  await page.goto(baseUrl);
  if (mode === "initial") {
    await expect(
      page.getByRole("heading", { name: "Create the owner account" }),
    ).toBeVisible();
    await page.getByLabel("Display name").fill("Phase 1 Owner");
    await page.getByLabel("Username").fill(ownerUsername);
    await page.getByLabel("Password").fill(ownerPassword);
    await page.getByRole("button", { name: "Create owner" }).click();

    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await page.getByLabel("Password").fill(ownerPassword);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(
      page.getByRole("heading", { name: "Connect Baikal" }),
    ).toBeVisible();
    await page.getByLabel("Baikal username").fill(davUsername);
    await page.getByLabel("Baikal password").fill(davPassword);
    await page.getByRole("button", { name: "Verify and connect" }).click();
    await expect(
      page.getByRole("heading", { name: "Week plan" }),
    ).toBeVisible();
    await expect(page.getByText(seedSummary)).toBeVisible();

    await page.getByLabel("What needs doing?").fill("Phase 1 task");
    await page
      .getByLabel("Notes", { exact: true })
      .last()
      .fill("Initial planning note");
    await page.getByRole("button", { name: "Capture task" }).click();
    await openTasks();
    let item = taskItem("Phase 1 task");
    await expect(item).toBeVisible();
    await item.getByLabel("Title").fill("Phase 1 planned task");
    await item.getByLabel("Notes").fill("Renamed through the browser");
    await item.getByRole("button", { name: "Save task" }).click();
    item = taskItem("Phase 1 planned task");
    await item.getByRole("button", { name: "Complete" }).click();
    await expect(item.getByText(/Completed/)).toBeVisible();
    await item.getByRole("button", { name: "Reopen" }).click();
    await expect(item.getByText(/Open/)).toBeVisible();
    page.once("dialog", (dialog) => void dialog.accept());
    await item.getByRole("button", { name: "Delete" }).click();
    await expect(taskItem("Phase 1 planned task")).toHaveCount(0);
    await page
      .locator(".recovery")
      .getByRole("button", { name: "Restore task" })
      .click();
    await expect(taskItem("Phase 1 planned task")).toBeVisible();

    const placed = await placeTask("Phase 1 planned task", localDateTime(24));
    expect(placed.response.status()).toBe(201);
    const moved = await placeTask(
      "Phase 1 planned task",
      localDateTime(30),
      "Move calendar block",
    );
    expect(moved.response.status()).toBe(201);
    await expect(
      taskItem("Phase 1 planned task").getByText(/45 minutes/),
    ).toBeVisible();
    writeFileSync(
      statePath,
      JSON.stringify({
        title: "Phase 1 planned task",
        taskId: moved.body.task.id,
        taskRevision: moved.body.task.revision,
        mapping: moved.body.mapping,
      }),
      { mode: 0o600 },
    );
    await context.storageState({ path: storagePath });
  } else if (mode === "restart") {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    await expect(
      page.getByRole("heading", { name: "Week plan" }),
    ).toBeVisible();
    await expect(page.getByText(seedSummary)).toHaveCount(1);
    await openTasks();
    await expect(taskItem(state.title)).toHaveCount(1);
    await expect(taskItem(state.title).getByText(/45 minutes/)).toBeVisible();

    const eventUrl = new URL(state.mapping.href, baikalUrl);
    const current = await globalThis.fetch(eventUrl, {
      headers: { Authorization: auth },
    });
    expect(current.status).toBe(200);
    const etag = current.headers.get("etag");
    if (!etag) throw new Error("mapped event did not return an ETag");
    const externalIcs = (await current.text()).replace(
      /SUMMARY:[^\r\n]*/,
      "SUMMARY:External edit preserved",
    );
    const changed = await globalThis.fetch(eventUrl, {
      method: "PUT",
      headers: {
        Authorization: auth,
        "Content-Type": "text/calendar; charset=utf-8",
        "If-Match": etag,
      },
      body: externalIcs,
    });
    expect([201, 204]).toContain(changed.status);

    const attempted = await placeTask(
      state.title,
      localDateTime(48),
      "Move calendar block",
    );
    expect(attempted.response.status()).toBe(409);
    await expect(
      page.getByText(
        "Calendar changed elsewhere. Refresh before updating this block.",
      ),
    ).toBeVisible();
    const preserved = await globalThis.fetch(eventUrl, {
      headers: { Authorization: auth },
    });
    expect(await preserved.text()).toContain("SUMMARY:External edit preserved");
  } else {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    await expect(
      page.getByRole("heading", { name: "Week plan" }),
    ).toBeVisible();
    await openTasks();
    await expect(taskItem(state.title)).toHaveCount(1);
    await openToday();
    await page.getByLabel("What needs doing?").fill("Post-restore task");
    await page.getByRole("button", { name: "Capture task" }).click();
    await openTasks();
    const placed = await placeTask("Post-restore task", localDateTime(72));
    expect(placed.response.status()).toBe(201);
    const restoredTask = taskItem("Post-restore task");
    await expect(restoredTask.getByText(/45 minutes/)).toBeVisible();
    await restoredTask
      .getByRole("button", { name: "Remove calendar block" })
      .click();
    await expect(restoredTask.getByText(/45 minutes/)).toHaveCount(0);
    await expect(
      restoredTask.getByRole("button", { name: "Schedule" }),
    ).toBeVisible();
  }
} finally {
  await context.close();
  await browser.close();
}
