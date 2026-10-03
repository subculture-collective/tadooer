import { describe, expect, it, vi } from "vitest";
import {
  applicationMenu,
  bindMenu,
  closeToTrayLabel,
  createDeepLinkInbox,
  loginItemOutcome,
  quitsWhenAllWindowsClose,
  registersSchemeAtRuntime,
  trayClickTogglesWindow,
  trayImageFile,
  trayImageIsTemplate,
} from "./platform.mjs";

const menuState = (overrides = {}) => ({
  platform: "darwin",
  appName: "Tadooer",
  packaged: true,
  closeToTray: false,
  startAtLogin: false,
  startAtLoginAvailable: true,
  serverFromEnvironment: false,
  ...overrides,
});

const flatten = (items) =>
  items.flatMap((item) => [item, ...flatten(item.submenu ?? [])]);

const names = (items) =>
  items.map((item) => item.role ?? item.label ?? item.type);

describe("platform conventions", () => {
  it("keeps the macOS app running without windows", () => {
    expect(quitsWhenAllWindowsClose("darwin")).toBe(false);
    expect(quitsWhenAllWindowsClose("linux")).toBe(true);
    expect(quitsWhenAllWindowsClose("win32")).toBe(true);
  });

  it("uses a template image for the macOS menu bar only", () => {
    expect(trayImageFile("darwin")).toBe("trayTemplate.png");
    expect(trayImageIsTemplate("darwin")).toBe(true);
    expect(trayImageFile("linux")).toBe("tray.png");
    expect(trayImageIsTemplate("linux")).toBe(false);
  });

  it("leaves a macOS menu-bar click to the menu", () => {
    expect(trayClickTogglesWindow("darwin")).toBe(false);
    expect(trayClickTogglesWindow("linux")).toBe(true);
  });

  it("names the close-to-tray setting after the platform", () => {
    expect(closeToTrayLabel("darwin")).toBe("Close to menu bar");
    expect(closeToTrayLabel("linux")).toBe("Close to tray");
  });

  it("registers the link scheme at runtime everywhere but Linux", () => {
    expect(registersSchemeAtRuntime("darwin")).toBe(true);
    expect(registersSchemeAtRuntime("win32")).toBe(true);
    expect(registersSchemeAtRuntime("linux")).toBe(false);
  });
});

describe("deep link inbox", () => {
  it("holds an open-url link that arrives before ready", () => {
    const inbox = createDeepLinkInbox();
    expect(inbox.receive("tadooer://open/today")).toBeUndefined();
    expect(inbox.start(["/Applications/Tadooer"])).toBe("tadooer://open/today");
  });

  it("keeps the latest of several early links", () => {
    const inbox = createDeepLinkInbox();
    inbox.receive("tadooer://open/today");
    inbox.receive("tadooer://open/inbox");
    expect(inbox.start([])).toBe("tadooer://open/inbox");
  });

  it("prefers a held link to the command line", () => {
    const inbox = createDeepLinkInbox();
    inbox.receive("tadooer://open/inbox");
    expect(inbox.start(["app", "tadooer://open/today"])).toBe(
      "tadooer://open/inbox",
    );
  });

  it("falls back to the command line, as Linux delivers links", () => {
    const inbox = createDeepLinkInbox();
    expect(inbox.start(["app", "--flag", "tadooer://open/today"])).toBe(
      "tadooer://open/today",
    );
  });

  it("starts with no link at all", () => {
    expect(createDeepLinkInbox().start(["app"])).toBeUndefined();
  });

  it("passes a link straight through once started", () => {
    const inbox = createDeepLinkInbox();
    inbox.start([]);
    expect(inbox.receive("tadooer://open/today")).toBe("tadooer://open/today");
  });

  it("hands a held link over once", () => {
    const inbox = createDeepLinkInbox();
    inbox.receive("tadooer://open/today");
    inbox.start([]);
    expect(inbox.start([])).toBeUndefined();
  });

  it("ignores anything that is not text", () => {
    const inbox = createDeepLinkInbox();
    expect(inbox.receive(undefined)).toBeUndefined();
    expect(inbox.receive({ url: "tadooer://open/today" })).toBeUndefined();
    expect(inbox.start([])).toBeUndefined();
  });
});

describe("login item outcome", () => {
  it("accepts a report that matches the request", () => {
    expect(loginItemOutcome(true, { openAtLogin: true })).toEqual({
      enabled: true,
      message: undefined,
    });
    expect(loginItemOutcome(false, { openAtLogin: false })).toEqual({
      enabled: false,
      message: undefined,
    });
  });

  it("explains a request macOS holds for approval", () => {
    const outcome = loginItemOutcome(true, {
      openAtLogin: false,
      status: "requires-approval",
    });
    expect(outcome.enabled).toBe(false);
    expect(outcome.message).toContain("Login Items");
  });

  it("reports a request the system did not take", () => {
    const outcome = loginItemOutcome(true, {
      openAtLogin: false,
      status: "not-found",
    });
    expect(outcome.enabled).toBe(false);
    expect(outcome.message).toContain("did not add");
  });

  it("reports an item the system kept", () => {
    const outcome = loginItemOutcome(false, { openAtLogin: true });
    expect(outcome.enabled).toBe(true);
    expect(outcome.message).toContain("still lists");
  });

  it("treats a missing report as not enabled", () => {
    expect(loginItemOutcome(false, undefined).enabled).toBe(false);
    expect(loginItemOutcome(true, undefined).enabled).toBe(false);
  });
});

describe("application menu", () => {
  it("lays out the macOS menu bar in the platform order", () => {
    const menu = applicationMenu(menuState());
    expect(names(menu)).toEqual([
      "Tadooer",
      "File",
      "editMenu",
      "View",
      "windowMenu",
    ]);
    expect(names(menu[0].submenu)).toEqual([
      "about",
      "separator",
      "Change server…",
      "Close to menu bar",
      "Start at login",
      "separator",
      "services",
      "separator",
      "hide",
      "hideOthers",
      "unhide",
      "separator",
      "quit",
    ]);
    expect(names(menu[1].submenu)).toEqual([
      "Quick capture",
      "Sync now",
      "separator",
      "close",
    ]);
  });

  it("leaves the macOS shortcuts to the roles, which use Cmd", () => {
    const items = flatten(applicationMenu(menuState()));
    expect(items.filter((item) => item.accelerator !== undefined)).toEqual([]);
    // Cmd+Q, Cmd+H, Cmd+W and the Edit shortcuts come with these roles.
    for (const role of ["quit", "hide", "close", "editMenu", "windowMenu"])
      expect(items.some((item) => item.role === role)).toBe(true);
    // Quit goes through the role, so there is no second Quit item.
    expect(items.some((item) => item.command === "quit")).toBe(false);
  });

  it("keeps the Linux layout and its one shortcut", () => {
    const menu = applicationMenu(menuState({ platform: "linux" }));
    expect(names(menu)).toEqual(["App", "editMenu", "View", "windowMenu"]);
    expect(names(menu[0].submenu)).toEqual([
      "Quick capture",
      "Sync now",
      "separator",
      "Change server…",
      "separator",
      "Close to tray",
      "Start at login",
      "separator",
      "Quit",
    ]);
    expect(menu[0].submenu.at(-1)).toEqual({
      label: "Quit",
      accelerator: "CmdOrCtrl+Q",
      command: "quit",
    });
    expect(flatten(menu).some((item) => item.role === "quit")).toBe(false);
  });

  it.each(["darwin", "linux"])(
    "has the Edit roles, Change server and both commands on %s",
    (platform) => {
      const items = flatten(applicationMenu(menuState({ platform })));
      expect(items.some((item) => item.role === "editMenu")).toBe(true);
      expect(
        items
          .map((item) => item.command)
          .filter((command) => command !== undefined)
          .sort(),
      ).toEqual(
        [
          "change-server",
          "quick-capture",
          "set-close-to-tray",
          "set-start-at-login",
          "sync-now",
          ...(platform === "linux" ? ["quit"] : []),
        ].sort(),
      );
    },
  );

  it.each(["darwin", "linux"])(
    "disables Change server when the environment sets it on %s",
    (platform) => {
      const items = flatten(
        applicationMenu(menuState({ platform, serverFromEnvironment: true })),
      );
      const server = items.find((item) => item.command === "change-server");
      expect(server).toMatchObject({
        label: "Server set by SUITE_SERVER_URL",
        enabled: false,
      });
    },
  );

  it("reflects the stored settings in the checkboxes", () => {
    const items = flatten(
      applicationMenu(
        menuState({
          closeToTray: true,
          startAtLogin: true,
          startAtLoginAvailable: false,
        }),
      ),
    );
    expect(
      items.find((item) => item.command === "set-close-to-tray"),
    ).toMatchObject({ type: "checkbox", checked: true });
    expect(
      items.find((item) => item.command === "set-start-at-login"),
    ).toMatchObject({ type: "checkbox", checked: true, enabled: false });
  });

  it("offers the developer tools in an unpackaged run only", () => {
    const has = (packaged) =>
      flatten(applicationMenu(menuState({ packaged }))).some(
        (item) => item.role === "toggleDevTools",
      );
    expect(has(false)).toBe(true);
    expect(has(true)).toBe(false);
  });
});

describe("menu binding", () => {
  const handlers = () => ({
    "quick-capture": vi.fn(),
    "sync-now": vi.fn(),
    "change-server": vi.fn(),
    "set-close-to-tray": vi.fn(),
    "set-start-at-login": vi.fn(),
    quit: vi.fn(),
  });

  it.each(["darwin", "linux"])(
    "gives every command a click and removes the command on %s",
    (platform) => {
      const bound = flatten(
        bindMenu(applicationMenu(menuState({ platform })), handlers()),
      );
      expect(bound.some((item) => "command" in item)).toBe(false);
      const clickable = bound.filter((item) => item.click !== undefined);
      expect(clickable).toHaveLength(platform === "linux" ? 6 : 5);
      expect(clickable.every((item) => item.role === undefined)).toBe(true);
    },
  );

  it("passes the checked state of a checkbox to its handler", () => {
    const all = handlers();
    const bound = flatten(bindMenu(applicationMenu(menuState()), all));
    bound
      .find((item) => item.label === "Start at login")
      .click({ checked: true });
    bound
      .find((item) => item.label === "Close to menu bar")
      .click({ checked: false });
    bound.find((item) => item.label === "Sync now").click({});
    expect(all["set-start-at-login"]).toHaveBeenCalledWith(true);
    expect(all["set-close-to-tray"]).toHaveBeenCalledWith(false);
    expect(all["sync-now"]).toHaveBeenCalledWith(false);
    expect(all.quit).not.toHaveBeenCalled();
  });

  it("does not change the template it was given", () => {
    const template = applicationMenu(menuState({ platform: "linux" }));
    const copy = JSON.parse(JSON.stringify(template));
    bindMenu(template, handlers());
    expect(template).toEqual(copy);
  });

  it("refuses a command without a handler", () => {
    expect(() =>
      bindMenu([{ label: "Open file", command: "open-file" }], handlers()),
    ).toThrow("open-file");
    expect(() =>
      bindMenu([{ label: "Inherited", command: "toString" }], handlers()),
    ).toThrow("toString");
  });
});
