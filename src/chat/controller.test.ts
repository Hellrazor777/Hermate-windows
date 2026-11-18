import { describe, expect, it } from "vitest";
import { EventRouter, type HermesEvent } from "../rpc";
import { ChatController, type ChatClient } from "./controller";

function fakeClient(handlers: Record<string, (params: Record<string, unknown>) => unknown> = {}) {
  const router = new EventRouter();
  const calls: [string, Record<string, unknown>][] = [];
  const client: ChatClient = {
    request: async (method, params = {}) => {
      calls.push([method, params]);
      const h = handlers[method];
      if (!h) throw new Error(`unexpected ${method}`);
      return h(params) as Record<string, unknown>;
    },
    onEvent: (sid, handler) => router.subscribe(sid, handler),
  };
  return { client, router, calls };
}

const base = {
  "session.create": () => ({ session_id: "s1" }),
  "prompt.submit": () => ({ status: "streaming", user_row_id: 42 }),
};
const emit = (router: EventRouter, sid: string | undefined, type: string, payload: Record<string, unknown> = {}) =>
  router.route({ type, session_id: sid, payload } as HermesEvent);

describe("ChatController", () => {
  it("creates the session once, submits, and streams the reply into the transcript", async () => {
    const { client, router, calls } = fakeClient(base);
    const chat = new ChatController(client);
    await chat.send("  hello  ");
    await chat.send("again?"); // fine: not running yet (no message.start seen)
    expect(calls.filter(([m]) => m === "session.create")).toHaveLength(1);
    expect(calls[1]).toEqual(["prompt.submit", { session_id: "s1", text: "hello" }]);
    expect(chat.get().items[0]).toEqual({ kind: "user", id: "user:42", text: "hello" });

    emit(router, "s1", "message.start", { turn_id: "t1" });
    emit(router, "s1", "message.delta", { text: "Hi!", turn_id: "t1", segment: 0, offset: 0 });
    emit(router, "s1", "message.complete", { text: "Hi!" });
    const last = chat.get().items[chat.get().items.length - 1];
    expect(last).toMatchObject({ kind: "assistant", text: "Hi!", sealed: true });
    expect(chat.get()).toMatchObject({ running: false, sessionId: "s1" });
  });

  it("drops events from other sessions and events with no session id", async () => {
    const { client, router } = fakeClient(base);
    const chat = new ChatController(client);
    await chat.send("hi");
    emit(router, "other", "message.start", { turn_id: "x" });
    emit(router, "other", "message.delta", { text: "leak", turn_id: "x", segment: 0, offset: 0 });
    emit(router, undefined, "message.delta", { text: "leak2", turn_id: "x", segment: 0, offset: 0 });
    emit(router, "", "error", { message: "not mine" });
    const s = chat.get();
    expect(s.items.filter((i) => i.kind === "assistant")).toHaveLength(0);
    expect(s.running).toBe(false);
    expect(s.error).toBeNull();
  });

  it("ignores sends while a turn is running and empty input", async () => {
    const { client, router, calls } = fakeClient(base);
    const chat = new ChatController(client);
    await chat.send("one");
    emit(router, "s1", "message.start", { turn_id: "t1" });
    await chat.send("two");
    await chat.send("   ");
    expect(calls.filter(([m]) => m === "prompt.submit")).toHaveLength(1);
  });

  it("interrupts only a running turn", async () => {
    const { client, router, calls } = fakeClient({ ...base, "session.interrupt": () => ({ status: "interrupted" }) });
    const chat = new ChatController(client);
    await chat.interrupt(); // no session yet: nothing happens
    await chat.send("go");
    await chat.interrupt(); // not running yet
    expect(calls.map(([m]) => m)).not.toContain("session.interrupt");
    emit(router, "s1", "message.start", { turn_id: "t1" });
    await chat.interrupt();
    expect(calls[calls.length - 1]).toEqual(["session.interrupt", { session_id: "s1" }]);
  });

  it("surfaces a failed submit as an error without adding a user row", async () => {
    const { client } = fakeClient({
      ...base,
      "prompt.submit": () => {
        throw new Error("session busy");
      },
    });
    const chat = new ChatController(client);
    await chat.send("hi");
    expect(chat.get().error).toBe("session busy");
    expect(chat.get().items).toHaveLength(0);
  });

  it("close() releases the Hermes session and tolerates a dead connection", async () => {
    const { client, calls } = fakeClient({ ...base, "session.close": () => ({ closed: true }) });
    const chat = new ChatController(client);
    await chat.send("hi");
    await chat.close();
    expect(calls[calls.length - 1]).toEqual(["session.close", { session_id: "s1" }]);

    const dead = fakeClient({ ...base, "session.close": () => { throw new Error("disconnected"); } });
    const chat2 = new ChatController(dead.client);
    await chat2.send("hi");
    await expect(chat2.close()).resolves.toBeUndefined();
  });

  it("stops listening after dispose", async () => {
    const { client, router } = fakeClient(base);
    const chat = new ChatController(client);
    await chat.send("hi");
    chat.dispose();
    emit(router, "s1", "message.start", { turn_id: "t1" });
    expect(chat.get().running).toBe(false);
  });
});
