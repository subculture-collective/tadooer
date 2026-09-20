import { expect, it, vi } from "vitest";
import type { PlannerResponse } from "@suite/contracts";
import { createPlannerLoader } from "./planner-loader.ts";

const deferred = () => {
  let resolve!: (value: PlannerResponse) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<PlannerResponse>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const window = {
  from: "2026-09-20T00:00:00.000Z",
  to: "2026-09-21T00:00:00.000Z",
};
const planner: PlannerResponse = {
  window,
  tasks: [],
  events: [],
  freshness: { state: "fresh", projectedAt: window.from, message: "Fresh" },
};

it("publishes only the newest requested range and ignores obsolete failures", async () => {
  const first = deferred(),
    second = deferred(),
    third = deferred();
  const publish = vi.fn(),
    status = vi.fn();
  const request = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockReturnValueOnce(third.promise);
  const controller = createPlannerLoader({
    request,
    publish,
    status,
    messageFor: () => "Could not load planner",
  });
  const a = controller.load(window),
    b = controller.load(window);
  second.resolve(planner);
  await b;
  first.reject(new Error("old failure"));
  await a;
  expect(publish).toHaveBeenCalledExactlyOnceWith(planner);
  expect(status).toHaveBeenLastCalledWith({ loading: false, error: null });
  const c = controller.load(window);
  third.reject(new Error("current failure"));
  await c;
  expect(status).toHaveBeenLastCalledWith({
    loading: false,
    error: "Could not load planner",
  });
});

it("invalidates in-flight work on session replacement, logout, unmount and StrictMode cleanup", async () => {
  const old = deferred(),
    fresh = deferred();
  const publish = vi.fn(),
    status = vi.fn();
  const request = vi
    .fn()
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(fresh.promise);
  const controller = createPlannerLoader({
    request,
    publish,
    status,
    messageFor: () => "failed",
  });
  const pending = controller.load(window);
  controller.dispose();
  await controller.load(window);
  expect(request).toHaveBeenCalledTimes(1);
  controller.activate();
  const current = controller.load(window);
  old.resolve(planner);
  await pending;
  expect(publish).not.toHaveBeenCalled();
  expect(status).toHaveBeenLastCalledWith({ loading: true, error: null });
  fresh.resolve(planner);
  await current;
  expect(publish).toHaveBeenCalledExactlyOnceWith(planner);
});
