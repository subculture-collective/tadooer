import { expect, it } from "vitest";
import { googleProjectionFreshness } from "./calendar-freshness.ts";

it("ages successful syncs without treating failures or future timestamps as fresh", () => {
  const now = new Date("2026-09-20T12:00:00Z");
  expect(
    googleProjectionFreshness("fresh", "2026-09-20T11:46:00Z", now).state,
  ).toBe("fresh");
  expect(
    googleProjectionFreshness("fresh", "2026-09-20T11:45:00Z", now).state,
  ).toBe("stale");
  expect(
    googleProjectionFreshness("stale", "2026-09-20T11:59:00Z", now).state,
  ).toBe("stale");
  expect(
    googleProjectionFreshness("fresh", "2026-09-20T12:01:00Z", now).state,
  ).toBe("stale");
  expect(googleProjectionFreshness("fresh", null, now).state).toBe(
    "unavailable",
  );
});
