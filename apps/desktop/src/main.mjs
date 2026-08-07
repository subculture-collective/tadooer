import { app, BrowserWindow, shell } from "electron";
import process from "node:process";
import console from "node:console";
import { allowedNavigation, suiteOrigin } from "./policy.mjs";

if (process.argv.includes("--suite-smoke")) {
  console.log(
    JSON.stringify({
      application: "productivity-suite-desktop",
      electron: process.versions.electron,
      authority: "remote-suite-origin",
    }),
  );
  app.exit(0);
} else {
  const origin = suiteOrigin(
    process.env.SUITE_SERVER_URL ?? "http://127.0.0.1:18080",
  );
  if (origin === undefined)
    throw new Error(
      "SUITE_SERVER_URL must be an HTTPS or loopback HTTP origin without credentials or a path",
    );
  const createWindow = () => {
    const window = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 760,
      minHeight: 560,
      title: "Productivity Suite",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        partition: "persist:suite-owner",
      },
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (allowedNavigation(url, origin)) return { action: "allow" };
      if (url.startsWith("https://")) void shell.openExternal(url);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (!allowedNavigation(url, origin)) event.preventDefault();
    });
    void window.loadURL(origin);
  };
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
  void app.whenReady().then(createWindow);
  app.on("window-all-closed", () => app.quit());
}
