import { describe, expect, it, vi } from "vitest";
import {
  createPageBridge,
  mobileBridgeGlobal,
  nativeChannelName,
  parseNativeMessage,
  readyMessage,
} from "./page-bridge.mjs";

const setup = () => {
  const native = { postMessage: vi.fn(), onmessage: null };
  const events = [];
  const target = {
    dispatchEvent: (event) => {
      events.push(event);
      return true;
    },
  };
  const bridge = createPageBridge({
    native,
    target,
    createEvent: (name, detail) => ({ name, detail }),
  });
  return { native, events, bridge };
};

const share = (value) => JSON.stringify({ type: "share", ...value });

describe("mobile page bridge", () => {
  it("has the desktop bridge's shape", () => {
    const { bridge } = setup();
    expect(bridge.version).toBe(1);
    expect(bridge.platform).toBe("android");
    expect(Object.isFrozen(bridge)).toBe(true);
    expect(Object.keys(bridge).sort()).toEqual([
      "notify",
      "platform",
      "ready",
      "reportFocus",
      "reportStatus",
      "version",
    ]);
    expect(mobileBridgeGlobal).toBe("tadooerMobile");
    expect(nativeChannelName).toBe("tadooerShellNative");
  });

  it("validates reports and sends nothing to the native side", () => {
    const { bridge, native } = setup();
    expect(
      bridge.reportStatus({ sync: "online", live: "live", conflicts: 0 }),
    ).toBe(true);
    expect(
      bridge.reportStatus({ sync: "online", live: "live", extra: 1 }),
    ).toBe(false);
    expect(bridge.reportFocus({ state: "idle" })).toBe(true);
    expect(
      bridge.reportFocus({ state: "running", phase: "focus", label: "Write" }),
    ).toBe(true);
    expect(bridge.reportFocus({ state: "sleeping" })).toBe(false);
    expect(native.postMessage).not.toHaveBeenCalled();
  });

  it("shows no notification and says so", () => {
    const { bridge, native } = setup();
    expect(bridge.notify({ title: "Reminder", path: "/today" })).toBe(false);
    expect(bridge.notify({ nonsense: true })).toBe(false);
    expect(native.postMessage).not.toHaveBeenCalled();
  });

  it("sends only the word ready", () => {
    const { bridge, native } = setup();
    expect(bridge.ready()).toBe(true);
    expect(bridge.ready("anything", { else: 1 })).toBe(true);
    expect(native.postMessage.mock.calls).toEqual([
      [readyMessage],
      [readyMessage],
    ]);
    native.postMessage.mockImplementation(() => {
      throw new Error("detached");
    });
    expect(bridge.ready()).toBe(false);
  });

  it("turns shared text into a quick-capture event", () => {
    const { native, events } = setup();
    native.onmessage({
      data: share({ subject: "An article", text: "https://example.org/a" }),
    });
    expect(events).toEqual([
      {
        name: "tadooer:quick-capture",
        detail: { text: "An article https://example.org/a" },
      },
    ]);
  });

  it("ignores anything that is not a share", () => {
    const { native, events } = setup();
    for (const data of [
      undefined,
      null,
      5,
      "",
      "ready",
      "{",
      "[]",
      "null",
      JSON.stringify({ type: "command", command: "sync-now" }),
      JSON.stringify({ type: "share" }),
      share({ text: " \n " }),
      share({ text: "x", url: "https://example.org" }),
      share({ text: "x".repeat(40_000) }),
    ])
      native.onmessage({ data });
    native.onmessage(undefined);
    expect(events).toEqual([]);
  });

  it("parses a native message into one capture line", () => {
    expect(parseNativeMessage(share({ text: "buy\nmilk" }))).toEqual({
      type: "share",
      text: "buy milk",
    });
    expect(parseNativeMessage(share({ subject: "Only" }))).toEqual({
      type: "share",
      text: "Only",
    });
    expect(parseNativeMessage({ type: "share", text: "x" })).toBeUndefined();
  });
});
