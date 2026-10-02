import { deepLinkFromArguments } from "./policy.mjs";

/**
 * Where the shell behaves differently per platform (ADR 0047, "macOS").
 * Every function here is pure: no Electron, no I/O. `shell.mjs` asks these
 * functions and does what they say; the tests cover them for `darwin` and
 * `linux` without either desktop.
 */

const mac = (platform) => platform === "darwin";

/**
 * macOS keeps an application running after its last window closes, and a
 * click on the Dock icon opens a window again. Elsewhere the last window
 * closing ends the application.
 */
export const quitsWhenAllWindowsClose = (platform) => !mac(platform);

/**
 * macOS draws a template image (black plus transparency) in the menu bar's
 * own colour; Electron also picks up the `@2x` file beside it. Elsewhere the
 * tray shows the coloured icon.
 */
export const trayImageFile = (platform) =>
  mac(platform) ? "trayTemplate.png" : "tray.png";

export const trayImageIsTemplate = (platform) => mac(platform);

/**
 * A click on a macOS menu-bar item opens its menu, which has the show and
 * hide entry. Elsewhere a click toggles the window and the menu is on the
 * secondary button.
 */
export const trayClickTogglesWindow = (platform) => !mac(platform);

export const closeToTrayLabel = (platform) =>
  mac(platform) ? "Close to menu bar" : "Close to tray";

/**
 * Linux registers `tadooer://` through an installed desktop entry. macOS
 * declares it in the bundle's `Info.plist`; the runtime call there, as on
 * Windows, also makes this copy the default handler.
 */
export const registersSchemeAtRuntime = (platform) => platform !== "linux";

/**
 * Deep links that arrive before the shell can open them.
 *
 * macOS delivers a link through the `open-url` event, and when the link is
 * what started the application the event fires before `ready`. `receive`
 * holds such a link (the latest one wins) and returns undefined; once
 * `start` has been called it returns the link for immediate handling.
 * `start` returns the link the first window should open: a held one, or
 * else the one on the command line, which is how Linux and Windows pass it.
 */
export const createDeepLinkInbox = () => {
  let started = false;
  let held;
  return {
    receive: (link) => {
      if (typeof link !== "string") return undefined;
      if (started) return link;
      held = link;
      return undefined;
    },
    start: (argv) => {
      started = true;
      const link = held ?? deepLinkFromArguments(argv);
      held = undefined;
      return link;
    },
  };
};

/**
 * What to do after asking the operating system for a login item, given what
 * it reports back (`app.getLoginItemSettings()`). macOS can hold a request
 * until the owner approves it in System Settings, and the owner can remove
 * the item there, so the stored setting follows the report, not the request.
 */
export const loginItemOutcome = (requested, reported) => {
  const enabled = reported?.openAtLogin === true;
  if (enabled === requested) return { enabled, message: undefined };
  if (requested && reported?.status === "requires-approval")
    return {
      enabled,
      message:
        "macOS is waiting for your approval. Allow the app under System Settings → General → Login Items & Extensions, then turn this on again.",
    };
  return {
    enabled,
    message: requested
      ? "The system did not add the app to the login items."
      : "The system still lists the app as a login item. Remove it under the system's login item settings.",
  };
};

const separator = Object.freeze({ type: "separator" });

/**
 * The application menu as data. Items the shell has to act on carry a
 * `command` instead of a `click`; `bindMenu` attaches the handlers. Items
 * with a `role` are Electron's own, with the platform's labels and
 * shortcuts: the Edit roles are what make copy and paste work in the page,
 * and on macOS `quit`, `hide` and `close` bring Cmd+Q, Cmd+H and Cmd+W.
 *
 * macOS gets the platform layout: the application menu (named after the
 * app by the system) with About, the server and shell settings, Services,
 * Hide and Quit; then File, Edit, View and Window. Elsewhere the layout is
 * App, Edit, View, Window, with one shortcut of the shell's own, Ctrl+Q.
 */
export const applicationMenu = ({
  platform,
  appName,
  packaged,
  closeToTray,
  startAtLogin,
  startAtLoginAvailable,
  serverFromEnvironment,
}) => {
  const actions = [
    { label: "Quick capture", command: "quick-capture" },
    { label: "Sync now", command: "sync-now" },
  ];
  const server = {
    label: serverFromEnvironment
      ? "Server set by SUITE_SERVER_URL"
      : "Change server…",
    enabled: !serverFromEnvironment,
    command: "change-server",
  };
  const toggles = [
    {
      label: closeToTrayLabel(platform),
      type: "checkbox",
      checked: closeToTray,
      command: "set-close-to-tray",
    },
    {
      label: "Start at login",
      type: "checkbox",
      checked: startAtLogin,
      enabled: startAtLoginAvailable,
      command: "set-start-at-login",
    },
  ];
  const view = {
    label: "View",
    submenu: [
      { role: "reload" },
      separator,
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      separator,
      { role: "togglefullscreen" },
      ...(packaged ? [] : [{ role: "toggleDevTools" }]),
    ],
  };
  if (mac(platform))
    return [
      {
        label: appName,
        submenu: [
          { role: "about" },
          separator,
          server,
          ...toggles,
          separator,
          { role: "services" },
          separator,
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          separator,
          { role: "quit" },
        ],
      },
      { label: "File", submenu: [...actions, separator, { role: "close" }] },
      { role: "editMenu" },
      view,
      { role: "windowMenu" },
    ];
  return [
    {
      label: "App",
      submenu: [
        ...actions,
        separator,
        server,
        separator,
        ...toggles,
        separator,
        { label: "Quit", accelerator: "CmdOrCtrl+Q", command: "quit" },
      ],
    },
    { role: "editMenu" },
    view,
    { role: "windowMenu" },
  ];
};

/**
 * Replaces each `command` of a menu template with a `click` that calls the
 * handler of that name with the item's checked state. A command without a
 * handler is a programming error and throws.
 */
export const bindMenu = (template, handlers) =>
  template.map((item) => {
    const { command, submenu, ...rest } = item;
    const bound = { ...rest };
    if (submenu !== undefined) bound.submenu = bindMenu(submenu, handlers);
    if (command !== undefined) {
      const handler = Object.hasOwn(handlers, command)
        ? handlers[command]
        : undefined;
      if (typeof handler !== "function")
        throw new Error(`No handler for the menu command ${command}`);
      bound.click = (menuItem) => handler(menuItem?.checked === true);
    }
    return bound;
  });
