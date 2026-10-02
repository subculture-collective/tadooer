import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFallbackTriggers, type FallbackReason } from "./fallback.ts";
import { FakePage } from "./test-fakes.ts";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const install = (live = false) => {
  const page = new FakePage();
  const reasons: FallbackReason[] = [];
  const state = { live };
  const triggers = installFallbackTriggers({
    environment: page,
    sync: (reason) => reasons.push(reason),
    isLive: () => state.live,
  });
  return { page, reasons, state, triggers };
};

describe("fallback sync triggers", () => {
  it("syncs when the page becomes visible or focused, at most once every five seconds", () => {
    const { page, reasons } = install();
    page.hide();
    expect(reasons).toEqual([]);
    page.show();
    page.focus();
    page.focus();
    expect(reasons).toEqual(["attention"]);
    vi.advanceTimersByTime(4_999);
    page.focus();
    expect(reasons).toEqual(["attention"]);
    vi.advanceTimersByTime(1);
    page.focus();
    expect(reasons).toEqual(["attention", "attention"]);
  });

  it("ignores focus while the page is hidden", () => {
    const { page, reasons } = install();
    page.hide();
    page.focus();
    expect(reasons).toEqual([]);
  });

  it("syncs every minute while the stream is down and the page is visible", () => {
    const { page, reasons } = install(false);
    vi.advanceTimersByTime(59_999);
    expect(reasons).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(reasons).toEqual(["interval"]);
    vi.advanceTimersByTime(120_000);
    expect(reasons).toEqual(["interval", "interval", "interval"]);
    page.hide();
    vi.advanceTimersByTime(600_000);
    expect(reasons).toHaveLength(3);
  });

  it("syncs every five minutes while the stream is live", () => {
    const { reasons, state } = install(true);
    vi.advanceTimersByTime(299_999);
    expect(reasons).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(reasons).toEqual(["interval"]);
    // The stream drops: back to the one-minute interval.
    state.live = false;
    vi.advanceTimersByTime(60_000);
    expect(reasons).toEqual(["interval", "interval"]);
  });

  it("delays the interval after a sync that ran for another reason", () => {
    const { reasons, triggers } = install(false);
    vi.advanceTimersByTime(45_000);
    triggers.noteSync();
    vi.advanceTimersByTime(15_000);
    expect(reasons).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(reasons).toEqual(["interval"]);
  });

  it("removes its listeners and timer on dispose", () => {
    const { page, reasons, triggers } = install();
    triggers.dispose();
    page.show();
    page.focus();
    vi.advanceTimersByTime(600_000);
    expect(reasons).toEqual([]);
    expect(page.window.listenerCount()).toBe(0);
    expect(page.document.listenerCount()).toBe(0);
  });
});
