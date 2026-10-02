/* global AbortSignal */
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  session,
  shell,
  Tray,
} from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";
import { pathToFileURL } from "node:url";
import { autostartPath, setAutostart } from "./autostart.mjs";
import {
  channels,
  createRateLimiter,
  focusLine,
  parseFocusReport,
  parseNotificationRequest,
  parseShellCommand,
  parseStatusReport,
  statusLine,
} from "./bridge.mjs";
import {
  allowedExternalOAuth,
  allowedNavigation,
  allowedPermission,
  deepLinkFromArguments,
  deepLinkScheme,
  deepLinkTarget,
  navigationTarget,
  normalizeServerInput,
  suiteOrigin,
} from "./policy.mjs";
import { checkServer, serverCheckMessage } from "./server-check.mjs";
import {
  defaultSettings,
  readSettings,
  settingsFileName,
  writeSettings,
} from "./settings.mjs";

/**
 * The Electron side of the desktop shell (ADR 0015, ADR 0047). It opens the
 * configured Suite origin in one sandboxed window and adds what a browser tab
 * cannot: a tray, a single instance, start at login, deep links and native
 * notifications. It holds no owner data and calls no Suite API except the
 * public `GET /api/build` during setup.
 *
 * Auto-update, code signing and the macOS and Windows packages are not here.
 * They are owner decisions; `start()` is the place a later update check would
 * be scheduled, and the platform branches are marked.
 */

const sourceDirectory = import.meta.dirname;
const applicationDirectory = join(sourceDirectory, "..");
export const preloadPath = join(applicationDirectory, "dist", "preload.cjs");
export const setupPreloadPath = join(
  applicationDirectory,
  "dist",
  "setup-preload.cjs",
);
const setupDirectory = join(sourceDirectory, "setup");
const setupPagePath = join(setupDirectory, "index.html");
const setupPageUrl = pathToFileURL(setupPagePath).href;
const setupDirectoryUrl = `${pathToFileURL(setupDirectory).href}/`;
const windowIconPath = join(applicationDirectory, "assets", "icon.png");
const trayIconPath = join(applicationDirectory, "assets", "tray.png");

const suitePartition = "persist:suite-owner";
// No `persist:` prefix: the setup page's session lives in memory only.
const setupPartition = "tadooer-setup";
const serverCheckTimeoutMs = 8000;

/**
 * `headless` is the self-check mode: windows stay hidden and the tray, the
 * autostart entry and the protocol registration are skipped, so a test run
 * leaves nothing on the desktop session.
 */
export const createShell = ({
  headless = false,
  environment = process.env,
} = {}) => {
  let settingsPath = "";
  let settings = { ...defaultSettings };
  let origin;
  let originFromEnvironment = false;
  let mainWindow = null;
  let setupWindow = null;
  let tray = null;
  let trayKey = "";
  let quitting = false;
  let ready = false;
  let pendingDeepLink;
  let pageStatus;
  let pageFocus;
  const notifications = new Map();
  const notificationAllowed = createRateLimiter(6, 60_000);

  const hasPage = () => mainWindow !== null && !mainWindow.isDestroyed();

  const showMainWindow = () => {
    if (!hasPage()) {
      if (setupWindow !== null) setupWindow.focus();
      else if (origin !== undefined) createMainWindow(origin);
      return;
    }
    if (headless) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };

  const toggleMainWindow = () => {
    if (hasPage() && mainWindow.isVisible() && !mainWindow.isMinimized())
      mainWindow.hide();
    else showMainWindow();
  };

  const sendCommand = (value) => {
    const command = parseShellCommand(value);
    if (command === undefined || !hasPage()) return false;
    if (command === "quick-capture") showMainWindow();
    mainWindow.webContents.send(channels.command, command);
    return true;
  };

  const quit = () => {
    quitting = true;
    app.quit();
  };

  // --- Tray ---------------------------------------------------------------

  const refreshTray = () => {
    if (tray === null) return;
    const visible = hasPage() && mainWindow.isVisible();
    const status = statusLine(pageStatus);
    const focus = focusLine(pageFocus);
    const key = JSON.stringify([visible, hasPage(), status, focus]);
    if (key === trayKey) return;
    trayKey = key;
    tray.setToolTip(`${app.getName()}: ${status}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: visible ? "Hide window" : "Show window",
          click: toggleMainWindow,
        },
        { type: "separator" },
        { label: status, enabled: false },
        ...(focus === undefined ? [] : [{ label: focus, enabled: false }]),
        { type: "separator" },
        {
          label: "Quick capture",
          enabled: hasPage(),
          click: () => sendCommand("quick-capture"),
        },
        {
          label: "Sync now",
          enabled: hasPage(),
          click: () => sendCommand("sync-now"),
        },
        { type: "separator" },
        { label: "Quit", click: quit },
      ]),
    );
  };

  const createTray = () => {
    if (headless) return;
    try {
      tray = new Tray(nativeImage.createFromPath(trayIconPath));
      tray.on("click", toggleMainWindow);
      refreshTray();
    } catch {
      // No tray host on this desktop. The window and the menu still work,
      // and close-to-tray stays off because there is nowhere to hide to.
      tray = null;
    }
  };

  // --- Settings toggles ---------------------------------------------------

  const saveSettings = async (change) => {
    settings = await writeSettings(settingsPath, { ...settings, ...change });
    buildMenu();
  };

  const startAtLoginAvailable = () => app.isPackaged && !headless;

  const setStartAtLogin = async (enabled) => {
    try {
      if (process.platform === "linux")
        await setAutostart({
          enabled,
          path: autostartPath(environment, homedir()),
          name: app.getName(),
          // An AppImage must start through its own file, not the mount.
          executable: environment.APPIMAGE ?? process.execPath,
        });
      // macOS and Windows: Electron's login item API. Untested until those
      // packages exist.
      else app.setLoginItemSettings({ openAtLogin: enabled });
      await saveSettings({ startAtLogin: enabled });
    } catch (error) {
      buildMenu();
      dialog.showErrorBox(
        "Start at login",
        error instanceof Error ? error.message : "The setting was not changed.",
      );
    }
  };

  // --- Application menu ---------------------------------------------------

  function buildMenu() {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "App",
          submenu: [
            {
              label: "Quick capture",
              click: () => sendCommand("quick-capture"),
            },
            { label: "Sync now", click: () => sendCommand("sync-now") },
            { type: "separator" },
            {
              label: originFromEnvironment
                ? "Server set by SUITE_SERVER_URL"
                : "Change server…",
              enabled: !originFromEnvironment,
              click: openSetup,
            },
            { type: "separator" },
            {
              label: "Close to tray",
              type: "checkbox",
              checked: settings.closeToTray,
              click: (item) => void saveSettings({ closeToTray: item.checked }),
            },
            {
              label: "Start at login",
              type: "checkbox",
              checked: settings.startAtLogin,
              enabled: startAtLoginAvailable(),
              click: (item) => void setStartAtLogin(item.checked),
            },
            { type: "separator" },
            { label: "Quit", accelerator: "CmdOrCtrl+Q", click: quit },
          ],
        },
        { role: "editMenu" },
        {
          label: "View",
          submenu: [
            { role: "reload" },
            { type: "separator" },
            { role: "resetZoom" },
            { role: "zoomIn" },
            { role: "zoomOut" },
            { type: "separator" },
            { role: "togglefullscreen" },
            ...(app.isPackaged ? [] : [{ role: "toggleDevTools" }]),
          ],
        },
        { role: "windowMenu" },
      ]),
    );
  }

  // --- Sessions -----------------------------------------------------------

  const configureSessions = () => {
    const suite = session.fromPartition(suitePartition);
    suite.setPermissionRequestHandler(
      (_contents, permission, callback, details) => {
        callback(allowedPermission(permission, details.requestingUrl, origin));
      },
    );
    suite.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
      allowedPermission(permission, requestingOrigin, origin),
    );

    const setup = session.fromPartition(setupPartition);
    setup.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    setup.setPermissionCheckHandler(() => false);
    // The setup page loads its own three files and nothing else.
    setup.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith(setupDirectoryUrl) });
    });
  };

  // --- Windows ------------------------------------------------------------

  function createMainWindow(initialUrl) {
    const window = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 760,
      minHeight: 560,
      title: app.getName(),
      icon: windowIconPath,
      show: !headless,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        partition: suitePartition,
        preload: preloadPath,
      },
    });
    const windowOrigin = origin;
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (allowedExternalOAuth(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    const guard = (event, url) => {
      if (!allowedNavigation(url, windowOrigin)) event.preventDefault();
    };
    window.webContents.on("will-navigate", guard);
    window.webContents.on("will-redirect", guard);
    window.webContents.on("did-navigate", () => {
      // A full load starts a new page; it reports its state again.
      pageStatus = undefined;
      pageFocus = undefined;
      refreshTray();
    });
    window.on("close", (event) => {
      if (quitting || window !== mainWindow) return;
      if (settings.closeToTray && tray !== null) {
        event.preventDefault();
        window.hide();
      }
    });
    window.on("show", refreshTray);
    window.on("hide", refreshTray);
    window.on("closed", () => {
      if (window !== mainWindow) return;
      mainWindow = null;
      pageStatus = undefined;
      pageFocus = undefined;
      refreshTray();
    });
    const previous = mainWindow;
    mainWindow = window;
    pageStatus = undefined;
    pageFocus = undefined;
    if (previous !== null && !previous.isDestroyed()) previous.destroy();
    void window.loadURL(initialUrl);
    refreshTray();
    return window;
  }

  function openSetup() {
    if (originFromEnvironment) return;
    if (setupWindow !== null) {
      setupWindow.focus();
      return;
    }
    const window = new BrowserWindow({
      width: 560,
      height: 540,
      resizable: false,
      title: "Connect to your server",
      icon: windowIconPath,
      show: !headless,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        partition: setupPartition,
        preload: setupPreloadPath,
      },
    });
    window.setMenuBarVisibility(false);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.on("closed", () => {
      if (setupWindow === window) setupWindow = null;
    });
    setupWindow = window;
    void window.loadFile(setupPagePath);
  }

  // --- Deep links ---------------------------------------------------------

  const openDeepLink = (raw) => {
    if (!ready) {
      pendingDeepLink = raw;
      return false;
    }
    const target = deepLinkTarget(raw, origin);
    if (target === undefined) return false;
    if (hasPage()) {
      showMainWindow();
      void mainWindow.loadURL(target);
    } else createMainWindow(target);
    return true;
  };

  // --- IPC ----------------------------------------------------------------

  const fromSuitePage = (event) => {
    const frame = event.senderFrame;
    return (
      hasPage() &&
      event.sender === mainWindow.webContents &&
      frame !== null &&
      frame.parent === null &&
      allowedNavigation(frame.url, origin)
    );
  };

  const fromSetupPage = (event) =>
    setupWindow !== null &&
    !setupWindow.isDestroyed() &&
    event.sender === setupWindow.webContents &&
    event.senderFrame !== null &&
    event.senderFrame.parent === null &&
    event.senderFrame.url === setupPageUrl;

  const showNotification = (request) => {
    if (!Notification.isSupported() || !notificationAllowed()) return;
    const key = request.tag ?? Symbol("untagged");
    notifications.get(key)?.close();
    const notification = new Notification({
      title: request.title,
      body: request.body,
    });
    // Held until it closes, so it is not collected while still on screen.
    notifications.set(key, notification);
    notification.on("close", () => {
      if (notifications.get(key) === notification) notifications.delete(key);
    });
    notification.on("click", () => {
      showMainWindow();
      const target =
        request.path === null
          ? undefined
          : navigationTarget(request.path, origin);
      if (target !== undefined && hasPage()) void mainWindow.loadURL(target);
    });
    notification.show();
  };

  const registerIpc = () => {
    ipcMain.on(channels.status, (event, value) => {
      const report = fromSuitePage(event)
        ? parseStatusReport(value)
        : undefined;
      if (report === undefined) return;
      pageStatus = report;
      refreshTray();
    });
    ipcMain.on(channels.focus, (event, value) => {
      const report = fromSuitePage(event) ? parseFocusReport(value) : undefined;
      if (report === undefined) return;
      pageFocus = report;
      refreshTray();
    });
    ipcMain.on(channels.notify, (event, value) => {
      const request = fromSuitePage(event)
        ? parseNotificationRequest(value)
        : undefined;
      if (request !== undefined) showNotification(request);
    });

    ipcMain.handle("tadooer-setup:state", (event) => {
      if (!fromSetupPage(event)) throw new Error("Forbidden");
      return { currentOrigin: settings.serverOrigin };
    });
    ipcMain.handle("tadooer-setup:cancel", (event) => {
      if (!fromSetupPage(event)) throw new Error("Forbidden");
      // Without a configured server there is nothing to go back to.
      if (origin !== undefined) setupWindow.close();
      return null;
    });
    ipcMain.handle("tadooer-setup:connect", async (event, value) => {
      if (!fromSetupPage(event)) throw new Error("Forbidden");
      if (
        typeof value !== "object" ||
        value === null ||
        typeof value.address !== "string" ||
        typeof value.allowPrivateLanHttp !== "boolean"
      )
        return {
          ok: false,
          reason: "invalid",
          message: serverCheckMessage("invalid"),
        };
      const result = await checkServer(normalizeServerInput(value.address), {
        allowPrivateLanHttp: value.allowPrivateLanHttp,
        fetchImplementation: (url, init) => net.fetch(url, init),
        signal: AbortSignal.timeout(serverCheckTimeoutMs),
      });
      if (!result.ok)
        return {
          ok: false,
          reason: result.reason,
          message: serverCheckMessage(result.reason),
        };
      settings = await writeSettings(settingsPath, {
        ...settings,
        serverOrigin: result.origin,
        allowPrivateLanHttp: result.transport === "private-lan-http",
      });
      origin = result.origin;
      createMainWindow(origin);
      const finished = setupWindow;
      // Close after the reply is on its way; the new window keeps the app
      // alive.
      setTimeout(() => {
        if (!finished.isDestroyed()) finished.close();
      }, 0);
      return { ok: true, version: result.version };
    });
  };

  // --- Start --------------------------------------------------------------

  const start = async () => {
    app.on("web-contents-created", (_event, contents) => {
      contents.on("will-attach-webview", (event) => event.preventDefault());
    });
    app.on("before-quit", () => {
      quitting = true;
    });
    app.on("window-all-closed", () => app.quit());
    app.on("second-instance", (_event, argv) => {
      const link = deepLinkFromArguments(argv);
      if (link === undefined || !openDeepLink(link)) showMainWindow();
    });
    // macOS delivers links here instead of on the command line.
    app.on("open-url", (event, url) => {
      event.preventDefault();
      openDeepLink(url);
    });

    await app.whenReady();
    settingsPath = join(app.getPath("userData"), settingsFileName);
    settings = await readSettings(settingsPath);

    const configured = environment.SUITE_SERVER_URL;
    if (typeof configured === "string" && configured !== "") {
      origin = suiteOrigin(configured);
      if (origin === undefined)
        throw new Error(
          "SUITE_SERVER_URL must be an HTTPS or loopback HTTP origin without credentials or a path",
        );
      originFromEnvironment = true;
    } else origin = settings.serverOrigin ?? undefined;

    // Linux registers the scheme through the installed desktop entry
    // (`MimeType=x-scheme-handler/tadooer`); see docs/operations/desktop.md.
    if (app.isPackaged && !headless && process.platform !== "linux")
      app.setAsDefaultProtocolClient(deepLinkScheme);

    configureSessions();
    registerIpc();
    buildMenu();
    createTray();
    ready = true;

    const link = pendingDeepLink ?? deepLinkFromArguments(process.argv);
    pendingDeepLink = undefined;
    if (origin === undefined) openSetup();
    else createMainWindow(deepLinkTarget(link, origin) ?? origin);
  };

  return {
    start,
    openDeepLink,
    sendCommand,
    // Read-only view for the self-check.
    probe: () => ({
      origin,
      settingsPath,
      mainWindow,
      setupWindow,
      statusLine: statusLine(pageStatus),
      focusLine: focusLine(pageFocus),
    }),
  };
};
