import { describe, expect, it } from "vitest";
import { HermesRpcError } from "../rpc";
import { KanbanStore, parseBoards, parseColumns, parseComments, parseTask, validateNewTask, type KanbanClient } from "./store";

/** A task exactly as `/api/plugins/kanban/board` returned it live (trimmed to what we read). */
const task = (over: Record<string, unknown> = {}) => ({
  id: "t_ea52f85e",
  title: "probe task",
  body: "hello",
  assignee: null,
  status: "ready",
  priority: 0,
  result: null,
  comment_count: 0,
  ...over,
});

const boardReply = (tasks: unknown[] = [task()]) => ({
  columns: [
    { name: "triage", tasks: [] },
    { name: "ready", tasks },
    { name: "done", tasks: [] },
  ],
  assignees: ["default", "prompty"],
});

const boardsReply = {
  boards: [
    { slug: "default", name: "Default", total: 0, archived: false },
    { slug: "media", name: "Media", total: 5, archived: false },
    { slug: "old", name: "Old", total: 1, archived: true },
  ],
  current: "media",
};

type Call = { method: string; path: string; body?: unknown };

function fake(handler: (c: Call) => unknown) {
  const calls: Call[] = [];
  const client: KanbanClient = {
    pluginRequest: async (method, path, body) => {
      const c = { method, path, body };
      calls.push(c);
      return (await handler(c)) as Record<string, never>;
    },
  };
  return { client, calls };
}

const ok = (c: Call) => {
  if (c.path.endsWith("/boards")) return boardsReply;
  if (c.path.includes("/board?")) return boardReply();
  return { ok: true };
};

describe("parsers", () => {
  it("reads a live task and refuses junk", () => {
    expect(parseTask(task({ assignee: "editor", comment_count: 2, result: "done!" }))).toEqual({
      id: "t_ea52f85e",
      title: "probe task",
      body: "hello",
      assignee: "editor",
      status: "ready",
      priority: 0,
      commentCount: 2,
      result: "done!",
    });
    expect(parseTask(null)).toBeNull();
    expect(parseTask({ title: "no id" })).toBeNull();
  });

  it("drops archived boards and malformed entries", () => {
    expect(parseBoards(boardsReply.boards).map((b) => b.slug)).toEqual(["default", "media"]);
    expect(parseBoards([null, { name: "x" }, "y"])).toEqual([]);
    expect(parseBoards(undefined)).toEqual([]);
  });

  it("keeps Hermes' column order and survives bad columns", () => {
    expect(parseColumns(boardReply().columns).map((c) => c.name)).toEqual(["triage", "ready", "done"]);
    expect(parseColumns([{ name: "x", tasks: [null, task()] }, { tasks: [] }, 5])).toHaveLength(1);
    expect(parseColumns("nope")).toEqual([]);
  });

  it("reads comments", () => {
    expect(parseComments([{ id: 1, author: "hermate", body: "hi", created_at: 5 }, { id: "x", body: "bad" }, { id: 2 }])).toEqual([
      { id: 1, author: "hermate", body: "hi", createdAt: 5 },
    ]);
  });

  it("validates a new task", () => {
    expect(validateNewTask({ title: "a" })).toBeNull();
    expect(validateNewTask({ title: "  " })).toMatch(/title/);
    expect(validateNewTask({ title: "x".repeat(201) })).toMatch(/too long/);
  });
});

describe("KanbanStore", () => {
  it("loads boards, defaults to Hermes' current board, and loads its columns", async () => {
    const { client, calls } = fake(ok);
    const store = new KanbanStore(client);
    await store.refresh();
    expect(calls.map((c) => c.path)).toEqual(["/api/plugins/kanban/boards", "/api/plugins/kanban/board?board=media"]);
    expect(store.get()).toMatchObject({ board: "media", loading: false, error: null, assignees: ["default", "prompty"] });
    expect(store.get().columns[1].tasks[0].title).toBe("probe task");
  });

  it("falls back to the first board when the current one is unknown, and shows none when there are none", async () => {
    const { client } = fake((c) => (c.path.endsWith("/boards") ? { boards: boardsReply.boards, current: "gone" } : boardReply()));
    const store = new KanbanStore(client);
    await store.refresh();
    expect(store.get().board).toBe("default");
    const empty = new KanbanStore(fake(() => ({ boards: [], current: null })).client);
    await empty.refresh();
    expect(empty.get()).toMatchObject({ board: null, columns: [], loading: false, error: null });
  });

  it("keeps the chosen board across a refresh and encodes it in the query", async () => {
    const { client, calls } = fake(ok);
    const store = new KanbanStore(client);
    await store.refresh();
    await store.selectBoard("default");
    expect(store.get().board).toBe("default");
    expect(calls[calls.length - 1]?.path).toBe("/api/plugins/kanban/board?board=default");
    await store.refresh();
    expect(calls[calls.length - 1]?.path).toBe("/api/plugins/kanban/board?board=default");
  });

  it("shows a failure (older Hermes without the plugin, or HTTP unavailable) and keeps the last good board", async () => {
    let fail = false;
    const { client } = fake((c) => {
      if (fail) throw new HermesRpcError("This connection cannot reach Hermes' HTTP API.");
      return ok(c);
    });
    const store = new KanbanStore(client);
    await store.refresh();
    fail = true;
    await store.refresh();
    expect(store.get().error).toMatch(/HTTP API/);
    expect(store.get().columns).toHaveLength(3);
    expect(store.get().loading).toBe(false);
  });

  it("creates a task with only the fields given, then reloads", async () => {
    const { client, calls } = fake(ok);
    const store = new KanbanStore(client);
    await store.refresh();
    calls.length = 0;
    expect(await store.create({ title: " Do it ", body: " ", assignee: "prompty" })).toBe(true);
    expect(calls[0]).toEqual({ method: "POST", path: "/api/plugins/kanban/tasks?board=media", body: { title: "Do it", assignee: "prompty" } });
    expect(calls.some((c) => c.path.includes("/board?"))).toBe(true);
  });

  it("does not send an invalid task, and says why", async () => {
    const { client, calls } = fake(ok);
    const store = new KanbanStore(client);
    await store.refresh();
    calls.length = 0;
    expect(await store.create({ title: "" })).toBe(false);
    expect(calls).toHaveLength(0);
    expect(store.get().error).toMatch(/title/);
  });

  it("keeps Hermes' refusal of a move visible after the reload that follows it", async () => {
    const detail = "Cannot move to 'ready': blocked by parent(s) not done";
    const { client } = fake((c) => {
      if (c.method === "PATCH") throw new HermesRpcError(detail, 409);
      return ok(c);
    });
    const store = new KanbanStore(client);
    await store.refresh();
    expect(await store.move("t_ea52f85e", "ready")).toBe(false);
    expect(store.get().error).toBe(detail);
  });

  it("moves, comments, and addresses the task id safely", async () => {
    const { client, calls } = fake(ok);
    const store = new KanbanStore(client);
    await store.refresh();
    calls.length = 0;
    await store.move("t_a/b", "blocked");
    await store.comment("t1", " hi ");
    await store.move("t2", "done", " shipped ");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([
      { method: "PATCH", path: "/api/plugins/kanban/tasks/t_a%2Fb?board=media", body: { status: "blocked" } },
      { method: "POST", path: "/api/plugins/kanban/tasks/t1/comments?board=media", body: { body: "hi", author: "hermate" } },
      { method: "PATCH", path: "/api/plugins/kanban/tasks/t2?board=media", body: { status: "done", result: "shipped" } },
    ]);
    calls.length = 0;
    expect(await store.move("t2", "done", "  ")).toBe(false);
    expect(calls).toHaveLength(0);
    expect(store.get().error).toMatch(/what was done/i);
    expect(await store.comment("t1", "  ")).toBe(false);
    expect(store.get().error).toMatch(/comment/i);
  });

  it("opens a task with its comments, refreshes it after a comment, and closes", async () => {
    const comments: unknown[] = [];
    const { client } = fake((c) => {
      if (c.method === "POST") comments.push({ id: comments.length + 1, author: "hermate", body: "hi", created_at: 1 });
      if (/\/tasks\/t_ea52f85e\?board/.test(c.path)) return { task: task({ comment_count: comments.length }), comments };
      return ok(c);
    });
    const store = new KanbanStore(client);
    await store.refresh();
    await store.open("t_ea52f85e");
    expect(store.get().detail?.comments).toEqual([]);
    await store.comment("t_ea52f85e", "hi");
    expect(store.get().detail?.comments).toHaveLength(1);
    store.close();
    expect(store.get().detail).toBeNull();
  });

  it("an older refresh never overwrites a newer one, and nothing updates after dispose", async () => {
    const resolvers: ((v: unknown) => void)[] = [];
    const { client } = fake((c) => (c.path.endsWith("/boards") ? { boards: boardsReply.boards, current: "media" } : new Promise((r) => resolvers.push(r))));
    const store = new KanbanStore(client);
    const first = store.refresh();
    const second = store.refresh();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    resolvers[1](boardReply([task({ id: "new", title: "new" })]));
    await second;
    resolvers[0](boardReply([task({ id: "stale", title: "stale" })]));
    await first;
    expect(store.get().columns[1].tasks.map((t) => t.id)).toEqual(["new"]);

    let notified = 0;
    store.subscribe(() => notified++);
    store.dispose();
    const third = store.refresh();
    await new Promise((r) => setTimeout(r, 0));
    resolvers[2](boardReply());
    await third;
    expect(notified).toBe(0);
  });
});
