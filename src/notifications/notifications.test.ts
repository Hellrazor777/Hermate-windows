import { describe, expect, it } from "vitest";
import { createDeliverer, type NotificationApi } from "./deliver";
import { Notifier, type NotifierInput } from "./notifier";

const base: NotifierInput = { state: "idle", pendingIds: [], focused: false, enabled: true };

describe("Notifier", () => {
  it("announces a request once, and not again while it stays pending", () => {
    const n = new Notifier();
    expect(n.observe({ ...base, state: "needs-you", pendingIds: ["a"] })).toEqual([
      { title: "Hermes needs you", body: "An approval or question is waiting." },
    ]);
    expect(n.observe({ ...base, state: "needs-you", pendingIds: ["a"] })).toEqual([]);
  });

  it("groups several new requests into one notice, and announces only the new one later", () => {
    const n = new Notifier();
    expect(n.observe({ ...base, pendingIds: ["a", "b"] })[0].body).toBe("2 approvals or questions are waiting.");
    expect(n.observe({ ...base, pendingIds: ["a", "b", "c"] })[0].body).toBe("An approval or question is waiting.");
  });

  it("announces again when an answered id comes back as a different request", () => {
    const n = new Notifier();
    n.observe({ ...base, pendingIds: ["a"] });
    n.observe({ ...base, pendingIds: [] });
    expect(n.observe({ ...base, pendingIds: ["b"] })).toHaveLength(1);
  });

  it("stays quiet while the window is focused, and does not replay it after the focus is lost", () => {
    const n = new Notifier();
    expect(n.observe({ ...base, focused: true, pendingIds: ["a"] })).toEqual([]);
    expect(n.observe({ ...base, focused: false, pendingIds: ["a"] })).toEqual([]);
  });

  it("announces a finished turn once, when the state becomes finished", () => {
    const n = new Notifier();
    n.observe({ ...base, state: "working" });
    expect(n.observe({ ...base, state: "finished" })).toEqual([{ title: "Hermes finished", body: "A reply is ready." }]);
    expect(n.observe({ ...base, state: "finished" })).toEqual([]);
    n.observe({ ...base, state: "working" });
    expect(n.observe({ ...base, state: "finished" })).toHaveLength(1);
  });

  it("sends nothing while notifications are off, and does not replay those events when they are turned on", () => {
    const n = new Notifier();
    expect(n.observe({ ...base, enabled: false, state: "finished", pendingIds: ["a"] })).toEqual([]);
    expect(n.observe({ ...base, enabled: true, state: "finished", pendingIds: ["a"] })).toEqual([]);
  });

  it("never puts reply text, commands or questions in a notice", () => {
    const n = new Notifier();
    const all = [...n.observe({ ...base, pendingIds: ["rm -rf secret"] }), ...n.observe({ ...base, state: "finished" })];
    expect(JSON.stringify(all)).not.toMatch(/rm -rf|secret/);
  });

  it("an offline connection is not a finish", () => {
    const n = new Notifier();
    n.observe({ ...base, state: "working" });
    expect(n.observe({ ...base, state: "offline" })).toEqual([]);
  });
});

function fakeApi(opts: { granted?: boolean; ask?: "granted" | "denied" | "default"; boom?: boolean } = {}) {
  const log = { checks: 0, asks: 0, sent: [] as string[] };
  const api: NotificationApi = {
    isPermissionGranted: async () => {
      log.checks++;
      if (opts.boom) throw new Error("no plugin");
      return opts.granted ?? false;
    },
    requestPermission: async () => {
      log.asks++;
      return opts.ask ?? "granted";
    },
    send: (n) => void log.sent.push(n.title),
  };
  return { api, log };
}

const notice = { title: "Hermes finished", body: "A reply is ready." };

describe("createDeliverer", () => {
  it("sends when permission is already granted, without asking", async () => {
    const { api, log } = fakeApi({ granted: true });
    await createDeliverer(api)([notice]);
    expect(log).toMatchObject({ asks: 0, sent: ["Hermes finished"] });
  });

  it("asks once, then remembers the answer", async () => {
    const { api, log } = fakeApi({ ask: "granted" });
    const deliver = createDeliverer(api);
    await deliver([notice]);
    await deliver([notice]);
    expect(log).toMatchObject({ checks: 1, asks: 1, sent: ["Hermes finished", "Hermes finished"] });
  });

  it("does not nag after a refusal", async () => {
    const { api, log } = fakeApi({ ask: "denied" });
    const deliver = createDeliverer(api);
    await deliver([notice]);
    await deliver([notice]);
    expect(log).toMatchObject({ asks: 1, sent: [] });
  });

  it("does nothing for no notices, and swallows a failure so the next try can work", async () => {
    const { api, log } = fakeApi({ granted: true });
    await createDeliverer(api)([]);
    expect(log.checks).toBe(0);
    const broken = fakeApi({ boom: true });
    const deliver = createDeliverer(broken.api);
    await expect(deliver([notice])).resolves.toBeUndefined();
    await deliver([notice]);
    expect(broken.log.checks).toBe(2);
  });
});
