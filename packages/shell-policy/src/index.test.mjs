import { describe, expect, it } from "vitest";
import * as desktopBridge from "../../../apps/desktop/src/bridge.mjs";
import * as desktopPolicy from "../../../apps/desktop/src/policy.mjs";
import * as desktopServerCheck from "../../../apps/desktop/src/server-check.mjs";
import * as shared from "./index.mjs";
import { captureTextLimit, shareCaptureText } from "./share.mjs";

describe("shared shell policy", () => {
  it("exports the desktop shell's own functions, not copies", () => {
    for (const name of [
      "allowedExternalOAuth",
      "allowedNavigation",
      "classifyServerAddress",
      "deepLinkTarget",
      "navigationTarget",
      "normalizeServerInput",
      "privateLanHost",
      "suiteBuildResponse",
      "suiteOrigin",
    ])
      expect(shared[name], name).toBe(desktopPolicy[name]);
    for (const name of [
      "createRateLimiter",
      "parseFocusReport",
      "parseNotificationRequest",
      "parseShellCommand",
      "parseStatusReport",
    ])
      expect(shared[name], name).toBe(desktopBridge[name]);
    expect(shared.checkServer).toBe(desktopServerCheck.checkServer);
    expect(shared.serverCheckMessage).toBe(
      desktopServerCheck.serverCheckMessage,
    );
    expect(shared.deepLinkScheme).toBe("tadooer");
    expect(shared.bridgeVersion).toBe(1);
    expect(shared.commandEvents["quick-capture"]).toBe("tadooer:quick-capture");
  });

  it("keeps the address rules a phone relies on", () => {
    const { classifyServerAddress } = shared;
    expect(classifyServerAddress("https://tasks.example.org")).toEqual({
      ok: true,
      origin: "https://tasks.example.org",
      transport: "https",
    });
    expect(classifyServerAddress("http://127.0.0.1:8080")).toMatchObject({
      ok: true,
      transport: "loopback-http",
    });
    // A Tailscale address is in 100.64/10 and needs the owner's consent.
    expect(classifyServerAddress("http://100.65.164.66:8080")).toEqual({
      ok: false,
      reason: "private-lan-consent",
    });
    expect(
      classifyServerAddress("http://100.65.164.66:8080", {
        allowPrivateLanHttp: true,
      }),
    ).toEqual({
      ok: true,
      origin: "http://100.65.164.66:8080",
      transport: "private-lan-http",
    });
    expect(
      classifyServerAddress("http://tasks.example.org", {
        allowPrivateLanHttp: true,
      }),
    ).toEqual({ ok: false, reason: "insecure-http" });
    expect(classifyServerAddress("https://user:pw@tasks.example.org")).toEqual({
      ok: false,
      reason: "credentials",
    });
  });

  it("limits a deep link to an application path of the configured origin", () => {
    const origin = "https://tasks.example.org";
    const { deepLinkTarget } = shared;
    expect(deepLinkTarget("tadooer://open/today", origin)).toBe(
      `${origin}/today`,
    );
    expect(deepLinkTarget("tadooer://open/tasks?view=inbox#top", origin)).toBe(
      `${origin}/tasks?view=inbox#top`,
    );
    expect(deepLinkTarget("tadooer://open", origin)).toBe(`${origin}/`);
    for (const refused of [
      "tadooer://evil.example/today",
      "tadooer://open//evil.example/x",
      "tadooer://open/api/data/export",
      "tadooer://open/a/../api/build",
      "tadooer://user@open/today",
      "tadooer://open:81/today",
      "https://tasks.example.org/today",
      "tadooer://open/a\\b",
    ])
      expect(deepLinkTarget(refused, origin), refused).toBeUndefined();
  });
});

describe("share-target capture text", () => {
  it("uses the shared text as one line", () => {
    expect(shareCaptureText({ text: "  buy\n\tmilk   today " })).toBe(
      "buy milk today",
    );
    expect(shareCaptureText({ text: "a\u0000b\u007fc" })).toBe("a b c");
  });

  it("puts a page title before its address", () => {
    expect(
      shareCaptureText({
        subject: "An article",
        text: "https://example.org/a?b=1#c",
      }),
    ).toBe("An article https://example.org/a?b=1#c");
    // Some apps repeat the subject inside the text.
    expect(
      shareCaptureText({ subject: "Note", text: "Note: call the bank" }),
    ).toBe("Note: call the bank");
    expect(shareCaptureText({ subject: "Only a subject" })).toBe(
      "Only a subject",
    );
  });

  it("fits a task title and shortens the subject before the text", () => {
    const address = `https://example.org/${"p".repeat(150)}`;
    const line = shareCaptureText({ subject: "s".repeat(300), text: address });
    expect(Array.from(line).length).toBe(captureTextLimit);
    expect(line.endsWith(` ${address}`)).toBe(true);

    const long = shareCaptureText({ subject: "Title", text: "x".repeat(500) });
    expect(long).toBe("x".repeat(captureTextLimit));
  });

  it("does not split a character when it cuts", () => {
    const line = shareCaptureText({ text: "😀".repeat(400) });
    expect(Array.from(line).length).toBe(captureTextLimit);
    expect(line.isWellFormed()).toBe(true);
  });

  it("returns nothing for an empty or malformed share", () => {
    for (const value of [
      undefined,
      null,
      "text",
      [],
      {},
      { text: "" },
      { text: " \n " },
      { text: 5, subject: {} },
    ])
      expect(shareCaptureText(value)).toBeUndefined();
  });
});
