import { describe, expect, it } from "vitest";
import { EventRouter, type HermesEvent } from "../rpc";
import { ChatController, transcriptFromHistory, type ChatClient } from "./controller";

type Handler = (params: Record<string, unknown>) => unknown;

function fakeClient(handlers: Record<string, Handler>) {
  const router = new EventRouter();
  const calls: [string, Record<string, unknown>][] = [];
  const client: ChatClient = {
    request: async (method, params = {}) => {
      calls.push([method, params]);
      const h = handlers[method];
      if (!h) throw new Error(`unexpected ${method}`);
      return (await h(params)) as Record<string, unknown>;
    },
    onEvent: (sid, handler) => router.subscribe(sid, handler),
  };
  return { client, router, calls };
}
const emit = (router: EventRouter, sid: string, type: string, payload: Record<string, unknown> = {}) =>
  router.route({ type, session_id: sid, payload } as HermesEvent);
const resumeReply = (over: Record<string, unknown> = {}) => ({
  session_id: "live1",
  resumed: "stored-1",
  messages: [
    { role: "user", text: "hello", row_id: 1 },
    { role: "assistant", text: "hi there", row_id: 2 },
  ],
  messages_omitted: false,
  running: false,
  ...over,
});

describe("transcriptFromHistory", () => {
  it("keeps user and assistant text, with row-based ids", () => {
    expect(transcriptFromHistory(resumeReply().messages)).toEqual([
      { kind: "user", id: "user:1", text: "hello" },
      { kind: "assistant", id: "history:2", text: "hi there", sealed: true },
    ]);
  });

  it("drops tool and system rows, empty text and junk instead of showing them", () => {
    const items = transcriptFromHistory([
      { role: "system", text: "SECRET SYSTEM PROMPT", row_id: 1 },
      { role: "tool", text: "huge tool output", row_id: 2 },
      { role: "assistant", text: "", row_id: 3 },
      { role: "assistant", text: 42, row_id: 4 },
      null,
      "x",
      { role: "user", text: "kept" },
    ]);
    expect(items).toEqual([{ kind: "user", id: "user:h0", text: "kept" }]);
    expect(transcriptFromHistory(undefined)).toEqual([]);
    expect(transcriptFromHistory({ not: "an array" })).toEqual([]);
  });
});

describe("ChatController.open", () => {
  it("resumes by stored id, shows the history and then streams new turns on the live id", async () => {
    const { client, router, calls } = fakeClient({
      "session.resume": () => resumeReply(),
      "prompt.submit": () => ({ user_row_id: 3 }),
    });
    const chat = new ChatController(client);
    await chat.open("stored-1");
    expect(calls[0]).toEqual(["session.resume", { session_id: "stored-1" }]);
    expect(chat.get()).toMatchObject({ sessionId: "live1", storedId: "stored-1", running: false, truncated: false });
    expect(chat.get().items).toHaveLength(2);

    await chat.send("and now?");
    expect(calls[1]).toEqual(["prompt.submit", { session_id: "live1", text: "and now?" }]);
    emit(router, "live1", "message.start", { turn_id: "t1" });
    emit(router, "live1", "message.delta", { text: "Sure", turn_id: "t1", segment: 0, offset: 0 });
    emit(router, "live1", "message.complete", { text: "Sure" });
    expect(chat.get().items.map((i) => i.kind)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("releases the session it leaves and stops listening to it", async () => {
    const { client, router, calls } = fakeClient({
      "session.create": () => ({ session_id: "old", stored_session_id: "stored-old" }),
      "prompt.submit": () => ({ user_row_id: 1 }),
      "session.close": () => ({}),
      "session.resume": () => resumeReply(),
    });
    const chat = new ChatController(client);
    await chat.send("first");
    expect(chat.get().storedId).toBe("stored-old");
    await chat.open("stored-1");
    expect(calls.some(([m, p]) => m === "session.close" && p.session_id === "old")).toBe(true);
    emit(router, "old", "message.delta", { text: "leak", turn_id: "x", segment: 0, offset: 0 });
    expect(chat.get().items.some((i) => i.kind === "assistant" && i.text === "leak")).toBe(false);
    expect(chat.get().items.some((i) => i.kind === "user" && i.text === "first")).toBe(false); // old transcript is gone
  });

  it("refuses to switch while a turn is running, and ignores the session that is already open", async () => {
    const { client, router, calls } = fakeClient({
      "session.resume": () => resumeReply(),
      "session.create": () => ({ session_id: "s1" }),
      "prompt.submit": () => ({ user_row_id: 1 }),
    });
    const chat = new ChatController(client);
    await chat.open("stored-1");
    await chat.open("stored-1"); // already open: no second resume
    expect(calls.filter(([m]) => m === "session.resume")).toHaveLength(1);
    emit(router, "live1", "message.start", { turn_id: "t1" });
    await chat.open("other");
    await chat.newSession();
    expect(calls.filter(([m]) => m === "session.resume")).toHaveLength(1);
    expect(chat.get().sessionId).toBe("live1");
  });

  it("shows a turn that is still running, and a truncated history", async () => {
    const { client } = fakeClient({ "session.resume": () => resumeReply({ running: true, messages_omitted: true }) });
    const chat = new ChatController(client);
    await chat.open("stored-1");
    expect(chat.get()).toMatchObject({ running: true, truncated: true });
  });

  it("reports a failed resume and leaves a usable empty chat", async () => {
    const { client } = fakeClient({
      "session.resume": () => {
        throw new Error("session not found");
      },
    });
    const chat = new ChatController(client);
    await chat.open("gone");
    expect(chat.get()).toMatchObject({ error: "session not found", sessionId: null, items: [] });
  });

  it("discards a slow resume that lost the race to a later switch, and releases its session", async () => {
    let finishFirst: (v: unknown) => void = () => undefined;
    const { client, calls } = fakeClient({
      "session.resume": (p) =>
        p.session_id === "slow"
          ? new Promise((r) => (finishFirst = r))
          : resumeReply({ session_id: "live2", resumed: "fast", messages: [{ role: "user", text: "fast one", row_id: 9 }] }),
      "session.close": () => ({}),
    });
    const chat = new ChatController(client);
    const first = chat.open("slow");
    await Promise.resolve();
    await chat.open("fast");
    finishFirst(resumeReply({ session_id: "live-slow", resumed: "slow" }));
    await first;
    expect(chat.get()).toMatchObject({ sessionId: "live2", storedId: "fast" });
    expect(calls.some(([m, p]) => m === "session.close" && p.session_id === "live-slow")).toBe(true);
  });
});

describe("ChatController.newSession", () => {
  it("clears the chat, releases the session, and creates a fresh one on the next message", async () => {
    let n = 0;
    const { client, calls } = fakeClient({
      "session.create": () => ({ session_id: `s${++n}`, stored_session_id: `st${n}` }),
      "prompt.submit": () => ({ user_row_id: n }),
      "session.close": () => ({}),
    });
    const chat = new ChatController(client);
    await chat.send("one");
    await chat.newSession();
    expect(chat.get()).toMatchObject({ sessionId: null, storedId: null, items: [] });
    expect(calls.some(([m, p]) => m === "session.close" && p.session_id === "s1")).toBe(true);
    await chat.send("two");
    expect(chat.get()).toMatchObject({ sessionId: "s2", storedId: "st2" });
  });
});
