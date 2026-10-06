#!/usr/bin/env node
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";
import { chromium, expect } from "@playwright/test";

const [mode, baseUrl, statePath] = process.argv.slice(2);
if (!["initial", "restart"].includes(mode) || !baseUrl || !statePath)
  throw new Error(
    "Usage: phase2-browser.mjs <initial|restart> <base-url> <state-path>",
  );

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const ownerUsername = required("PHASE2_OWNER_USERNAME");
const ownerPassword = required("PHASE2_OWNER_PASSWORD");
const davUsername = required("BAIKAL_DAV_USERNAME");
const davPassword = required("BAIKAL_DAV_PASSWORD");
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/usr/bin/chromium";
const profileOne = `${statePath}.profile-one`;
const profileTwo = `${statePath}.profile-two`;
const task = (page, title) =>
  page.locator(".today-task-row, .task-view-group > .tasks > li", {
    hasText: title,
  });
const openTasks = async (page) => {
  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Captured tasks" }),
  ).toBeVisible();
};

const open = async (path) =>
  chromium.launchPersistentContext(path, { executablePath, headless: true });
const login = async (page) => {
  await page.goto(baseUrl);
  await expect(
    page.getByRole("heading", {
      name: /^(Create the owner account|Sign in|Connect Baikal|Today)$/,
    }),
  ).toBeVisible();
  if (
    await page
      .getByRole("heading", { name: "Create the owner account" })
      .isVisible()
      .catch(() => false)
  ) {
    await page.getByLabel("Display name").fill("Phase 2 Owner");
    await page.getByLabel("Username").fill(ownerUsername);
    await page.getByLabel("Password").fill(ownerPassword);
    await page.getByRole("button", { name: "Create owner" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  }
  if (
    await page
      .getByRole("heading", { name: "Sign in" })
      .isVisible()
      .catch(() => false)
  ) {
    await page.getByLabel("Username").fill(ownerUsername);
    await page.getByLabel("Password").fill(ownerPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(
      page.getByRole("heading", { name: /^(Connect Baikal|Today)$/ }),
    ).toBeVisible();
  }
  if (
    await page
      .getByRole("heading", { name: "Connect Baikal" })
      .isVisible()
      .catch(() => false)
  ) {
    await page.getByLabel("Baikal username").fill(davUsername);
    await page.getByLabel("Baikal password").fill(davPassword);
    await page.getByRole("button", { name: "Verify and connect" }).click();
  }
  await expect(
    page.getByRole("heading", { name: "Today", exact: true }),
  ).toBeVisible();
};

if (mode === "restart") {
  const context = await open(profileOne);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(baseUrl);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    await expect(task(page, state.title)).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Focus session" }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
  process.exit(0);
}

rmSync(profileOne, { recursive: true, force: true });
rmSync(profileTwo, { recursive: true, force: true });
mkdirSync(profileOne, { recursive: true });
mkdirSync(profileTwo, { recursive: true });
const first = await open(profileOne);
let firstClosed = false;
try {
  const firstPage = first.pages()[0] ?? (await first.newPage());
  await login(firstPage);
  await firstPage.context().setOffline(true);
  await firstPage.getByLabel("What needs doing?").fill("Phase 2 offline task");
  await firstPage.getByRole("button", { name: "Capture task" }).click();
  await openTasks(firstPage);
  let item = task(firstPage, "Phase 2 offline task");
  await expect(item).toBeVisible();
  await item.getByLabel("Title").fill("Phase 2 cached task");
  await item.getByRole("button", { name: "Save task" }).click();
  await expect(task(firstPage, "Phase 2 cached task")).toBeVisible();
  await first.close();
  firstClosed = true;

  const reopened = await open(profileOne);
  try {
    const page = reopened.pages()[0] ?? (await reopened.newPage());
    await reopened.setOffline(true);
    await page.goto(baseUrl);
    await expect(task(page, "Phase 2 cached task")).toBeVisible();
    await reopened.setOffline(false);
    await expect(page.getByRole("button", { name: "Sync now" })).toBeEnabled();
    await page.getByRole("button", { name: "Sync now" }).click();
    await expect(page.getByText("Task sync is on.")).toBeVisible();
    const second = await open(profileTwo);
    try {
      const secondPage = second.pages()[0] ?? (await second.newPage());
      await login(secondPage);
      await expect(task(secondPage, "Phase 2 cached task")).toBeVisible();
      await expect(task(secondPage, "Phase 2 cached task")).toHaveCount(1);

      await openTasks(page);
      await openTasks(secondPage);
      await reopened.setOffline(true);
      await second.setOffline(true);
      item = task(page, "Phase 2 cached task");
      await item.getByLabel("Title").fill("Phase 2 conflict winner");
      await item.getByRole("button", { name: "Save task" }).click();
      const secondItem = task(secondPage, "Phase 2 cached task");
      await secondItem.getByLabel("Title").fill("Phase 2 conflict loser");
      await secondItem.getByRole("button", { name: "Save task" }).click();
      await expect(task(page, "Phase 2 conflict winner")).toBeVisible();
      await expect(task(secondPage, "Phase 2 conflict loser")).toBeVisible();
      await reopened.setOffline(false);
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Sync now" }),
      ).toBeEnabled();
      await page.getByRole("button", { name: "Sync now" }).click();
      await expect(page.getByText("Task sync: online")).toBeVisible();
      await second.setOffline(false);
      await secondPage
        .getByRole("link", { name: "Settings", exact: true })
        .click();
      await expect(
        secondPage.getByRole("button", { name: "Sync now" }),
      ).toBeEnabled();
      await secondPage.getByRole("button", { name: "Sync now" }).click();
      await expect(
        secondPage.getByText("Conflicts: 1", { exact: true }),
      ).toBeVisible();
      await openTasks(secondPage);
      await expect(task(secondPage, "Phase 2 conflict winner")).toHaveCount(1);

      await page.goto(new URL("/today", baseUrl).href);
      await page
        .getByRole("button", {
          name: "Start focus on “Phase 2 conflict winner”",
        })
        .click();
      await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
      await secondPage.goto(new URL("/today", baseUrl).href);
      await expect(
        secondPage.getByRole("button", { name: "Take over on this device" }),
      ).toBeVisible();
      await secondPage
        .getByRole("button", { name: "Take over on this device" })
        .click();
      await expect(
        secondPage.getByRole("button", { name: "Pause" }),
      ).toBeVisible();
    } finally {
      await second.close();
    }
    writeFileSync(
      statePath,
      JSON.stringify({ title: "Phase 2 conflict winner" }),
      { mode: 0o600 },
    );
  } finally {
    await reopened.close();
  }
} finally {
  // `first` may already be closed while exercising persistent-profile restart.
  if (!firstClosed) await first.close();
}
