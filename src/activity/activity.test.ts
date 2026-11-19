import { describe, expect, it } from "vitest";
import { deriveActivity, FinishTracker, type ActivityInputs } from "./activity";

const base: ActivityInputs = { connection: "connected", pendingRequests: 0, running: false, unseenFinish: false };
const d = (over: Partial<ActivityInputs>) => deriveActivity({ ...base, ...over });

describe("deriveActivity", () => {
  it("maps each state", () => {
    expect(d({})).toBe("idle");
    expect(d({ running: true })).toBe("working");
    expect(d({ pendingRequests: 1 })).toBe("needs-you");
    expect(d({ unseenFinish: true })).toBe("finished");
    expect(d({ connection: "closed" })).toBe("offline");
  });

  it("treats anything but connected as offline, whatever else is going on", () => {
    for (const connection of ["idle", "connecting", "reconnecting", "closed"] as const) {
      expect(d({ connection, running: true, pendingRequests: 2, unseenFinish: true })).toBe("offline");
    }
  });

  it("prioritises needs-you over working over finished", () => {
    expect(d({ pendingRequests: 1, running: true, unseenFinish: true })).toBe("needs-you");
    expect(d({ running: true, unseenFinish: true })).toBe("working");
  });
});

describe("FinishTracker", () => {
  it("flags a completed turn until acknowledged", () => {
    const t = new FinishTracker();
    expect(t.observe(false, null)).toBe(false);
    expect(t.observe(true, null)).toBe(false);
    expect(t.observe(false, null)).toBe(true);
    expect(t.observe(false, null)).toBe(true); // stays until seen
    expect(t.acknowledge()).toBe(false);
    expect(t.observe(false, null)).toBe(false);
  });

  it("does not flag a turn that ended in an error", () => {
    const t = new FinishTracker();
    t.observe(true, null);
    expect(t.observe(false, "boom")).toBe(false);
  });

  it("clears the flag when the next turn starts", () => {
    const t = new FinishTracker();
    t.observe(true, null);
    t.observe(false, null);
    expect(t.unseenFinish).toBe(true);
    expect(t.observe(true, null)).toBe(false);
  });
});
