import { describe, expect, it, vi } from "vitest";
import { liveSyncResourceFamilies } from "@suite/contracts";
import { liveSyncFamilyViews, liveViews, LiveViewRegistry } from "./views.ts";

const own = "d1054acd-c04d-4bd8-a814-254b007154ba";
const other = "7c0a4a3e-8d0b-4b53-9a53-0a7f0c7f5a11";

describe("live sync resource families", () => {
  it("has a registry entry for every family in the contract", () => {
    expect(Object.keys(liveSyncFamilyViews).toSorted()).toEqual(
      [...liveSyncResourceFamilies].toSorted(),
    );
    for (const family of liveSyncResourceFamilies) {
      const views = liveSyncFamilyViews[family];
      expect(Array.isArray(views), family).toBe(true);
      for (const view of views) expect(liveViews, family).toContain(view);
    }
  });

  it("maps `all` to every view and uses every view in some family", () => {
    expect(liveSyncFamilyViews.all).toEqual(liveViews);
    expect(new Set(liveViews).size).toBe(liveViews.length);
  });

  it("refetches nothing for the retired day_orders family (ADR 0050)", () => {
    // Saved day orders are feed records read from the offline cache.
    expect(liveSyncFamilyViews.day_orders).toEqual([]);
    expect(liveViews).not.toContain("dayOrders");
    // A planned day still refreshes the day plan, not a day-order view.
    expect(liveSyncFamilyViews.task_planning).toEqual(["dayPlan"]);
    const registry = new LiveViewRegistry();
    const plan = vi.fn();
    registry.register("dayPlan", plan);
    expect(
      registry.refetch(["day_orders"], {
        sourceClientId: null,
        ownClientId: own,
      }),
    ).toEqual([]);
    expect(plan).not.toHaveBeenCalled();
  });

  it("refetches nothing for the retired notes family (ADR 0046)", () => {
    // Notes are feed records read from the offline cache; no view loads
    // them over HTTP, so a hint from an older server has nothing to do.
    expect(liveSyncFamilyViews.notes).toEqual([]);
    expect(liveViews).not.toContain("notes");
    const registry = new LiveViewRegistry();
    const links = vi.fn();
    registry.register("taskLinks", links);
    expect(
      registry.refetch(["notes"], { sourceClientId: null, ownClientId: own }),
    ).toEqual([]);
    expect(links).not.toHaveBeenCalled();
  });
});

describe("LiveViewRegistry", () => {
  it("refetches only the loaded views of the named families", () => {
    const registry = new LiveViewRegistry();
    const links = vi.fn();
    const boards = vi.fn();
    registry.register("taskLinks", links);
    registry.register("boards", boards);
    const refetched = registry.refetch(["task_links", "counters"], {
      sourceClientId: other,
      ownClientId: own,
    });
    expect(refetched).toEqual(["taskLinks"]);
    expect(links).toHaveBeenCalledTimes(1);
    expect(boards).not.toHaveBeenCalled();
  });

  it("does nothing for a family whose views are not loaded", () => {
    const registry = new LiveViewRegistry();
    expect(
      registry.refetch(["time_entries"], {
        sourceClientId: null,
        ownClientId: own,
      }),
    ).toEqual([]);
  });

  it("skips the refetch when this client caused the change", () => {
    const registry = new LiveViewRegistry();
    const links = vi.fn();
    registry.register("taskLinks", links);
    expect(
      registry.refetch(["task_links"], {
        sourceClientId: own,
        ownClientId: own,
      }),
    ).toEqual([]);
    expect(links).not.toHaveBeenCalled();
    // A server-side change has no source client and is always refetched.
    registry.refetch(["task_links"], {
      sourceClientId: null,
      ownClientId: own,
    });
    expect(links).toHaveBeenCalledTimes(1);
  });

  it("refetches everything loaded on `all`, each view once", () => {
    const registry = new LiveViewRegistry();
    const links = vi.fn();
    const planner = vi.fn();
    const dayPlan = vi.fn();
    registry.register("taskLinks", links);
    registry.register("planner", planner);
    registry.register("dayPlan", dayPlan);
    registry.refetch(["all", "calendar"], {
      sourceClientId: null,
      ownClientId: own,
    });
    expect(links).toHaveBeenCalledTimes(1);
    expect(planner).toHaveBeenCalledTimes(1);
    expect(dayPlan).toHaveBeenCalledTimes(1);
  });

  it("stops refetching a view that unregistered and survives a failing loader", async () => {
    const registry = new LiveViewRegistry();
    const first = vi.fn(() => Promise.reject(new Error("offline")));
    const second = vi.fn(() => {
      throw new Error("broken");
    });
    const third = vi.fn();
    const unregister = registry.register("taskLinks", first);
    registry.register("taskLinks", second);
    registry.register("taskLinks", third);
    registry.refetch(["task_links"], {
      sourceClientId: null,
      ownClientId: own,
    });
    await Promise.resolve();
    expect(third).toHaveBeenCalledTimes(1);
    unregister();
    registry.refetch(["task_links"], {
      sourceClientId: null,
      ownClientId: own,
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(third).toHaveBeenCalledTimes(2);
  });
});
