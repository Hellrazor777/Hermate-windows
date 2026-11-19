import { describe, expect, it } from "vitest";
import { parseSessions, SessionList, type SessionsClient } from "./list";

const entry = (id: string, startedAt: number, extra: Record<string, unknown> = {}) => ({
  id,
  title: `T-${id}`,
  preview: `P-${id}`,
  started_at: startedAt,
  message_count: 2,
  source: "desktop",
  ...extra,
});

function client(handlers: Record<string, (p: Record<string, unknown>) => unknown>) {
  const calls: [string, Record<string, unknown>][] = [];
  const c: SessionsClient = {
    request: async (method, params = {}) => {
      calls.push([method, params]);
      return (await handlers[method](params)) as Record<string, unknown>;
    },
  };
  return { c, calls };
}

describe("parseSessions", () => {
  it("maps the verified fields and sorts newest first", () => {
    const out = parseSessions([entry("old", 100), entry("new", 300), entry("mid", 200)]);
    expect(out.map((s) => s.id)).toEqual(["new", "mid", "old"]);
    expect(out[0]).toEqual({ id: "new", title: "T-new", preview: "P-new", startedAt: 300, messageCount: 2, source: "desktop" });
  });

  it("drops malformed entries and fills safe defaults", () => {
    const out = parseSessions([null, "x", { title: "no id" }, { id: "" }, { id: "ok", title: "  ", started_at: "soon", message_count: NaN }]);
    expect(out).toEqual([{ id: "ok", title: "Untitled", preview: "", startedAt: 0, messageCount: 0, source: "" }]);
    expect(parseSessions(undefined)).toEqual([]);
  });
});

describe("SessionList", () => {
  it("loads the list with a limit, and shows an error without losing the last good list", async () => {
    let fail = false;
    const { c, calls } = client({
      "session.list": () => {
        if (fail) throw new Error("disconnected");
        return { sessions: [entry("a", 1)] };
      },
    });
    const list = new SessionList(c);
    await list.refresh();
    expect(calls[0]).toEqual(["session.list", { limit: 50 }]);
    expect(list.get()).toMatchObject({ loading: false, error: null });
    expect(list.get().sessions.map((s) => s.id)).toEqual(["a"]);
    fail = true;
    await list.refresh();
    expect(list.get().error).toBe("disconnected");
    expect(list.get().sessions).toHaveLength(1);
  });

  it("an older refresh never overwrites a newer one", async () => {
    const resolvers: ((v: unknown) => void)[] = [];
    const { c } = client({ "session.list": () => new Promise((r) => resolvers.push(r)) });
    const list = new SessionList(c);
    const first = list.refresh();
    const second = list.refresh();
    resolvers[1]({ sessions: [entry("new", 2)] });
    await second;
    resolvers[0]({ sessions: [entry("stale", 1)] });
    await first;
    expect(list.get().sessions.map((s) => s.id)).toEqual(["new"]);
  });

  it("deletes by stored id and removes it from the list; a refused delete keeps it and reports why", async () => {
    let refuse = false;
    const { c, calls } = client({
      "session.list": () => ({ sessions: [entry("a", 2), entry("b", 1)] }),
      "session.delete": () => {
        if (refuse) throw new Error("session is active");
        return { deleted: "a" };
      },
    });
    const list = new SessionList(c);
    await list.refresh();
    refuse = true;
    expect(await list.remove("a")).toBe(false);
    expect(list.get().error).toBe("session is active");
    expect(list.get().sessions).toHaveLength(2);
    refuse = false;
    expect(await list.remove("a")).toBe(true);
    expect(calls.filter(([m]) => m === "session.delete").map(([, p]) => p)).toEqual([{ session_id: "a" }, { session_id: "a" }]);
    expect(list.get().sessions.map((s) => s.id)).toEqual(["b"]);
    expect(list.get().error).toBeNull();
  });

  it("does not update after dispose", async () => {
    const { c } = client({ "session.list": () => ({ sessions: [entry("a", 1)] }) });
    const list = new SessionList(c);
    let notified = 0;
    list.subscribe(() => notified++);
    list.dispose();
    await list.refresh();
    expect(notified).toBe(0);
    expect(list.get().sessions).toEqual([]);
  });
});
