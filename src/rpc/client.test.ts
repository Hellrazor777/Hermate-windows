import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildWebSocketUrl, HermesClient, type WebSocketLike } from "./client";
import { EventRouter } from "./router";
import { parseFrame } from "./frames";
import { HermesAuthError, HermesDisconnectedError, HermesRpcError, HermesTimeoutError, type HermesEvent } from "./types";

class FakeSocket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: Record<string, unknown>[] = [];
  closed = false;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.({});
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }
  drop() {
    this.onclose?.({});
  }
}

function setup(opts: { token?: string } = {}) {
  const sockets: FakeSocket[] = [];
  const client = new HermesClient({
    baseUrl: "http://127.0.0.1:9119",
    token: opts.token ?? "tok",
    requestTimeoutMs: 1000,
    reconnect: { initialDelayMs: 100, maxDelayMs: 400 },
    webSocketFactory: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
  });
  return { client, sockets };
}

async function connected() {
  const ctx = setup();
  const p = ctx.client.connect();
  ctx.sockets[0].open();
  await p;
  return ctx;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("buildWebSocketUrl", () => {
  it("maps http->ws and https->wss and encodes the token", () => {
    expect(buildWebSocketUrl("http://127.0.0.1:9119", "a+b/c")).toBe("ws://127.0.0.1:9119/api/ws?token=a%2Bb%2Fc");
    expect(buildWebSocketUrl("https://hermes.example.com/", "t")).toBe("wss://hermes.example.com/api/ws?token=t");
  });
  it("rejects empty or newline tokens and bad schemes", () => {
    expect(() => buildWebSocketUrl("http://x", "")).toThrow(HermesAuthError);
    expect(() => buildWebSocketUrl("http://x", "a\nb")).toThrow(HermesAuthError);
    expect(() => buildWebSocketUrl("ftp://x", "t")).toThrow(HermesRpcError);
  });
});

describe("HermesClient requests", () => {
  it("correlates responses by id", async () => {
    const { client, sockets } = await connected();
    const a = client.request("session.create", { cwd: "C:\\x" });
    const b = client.request("profiles.list");
    expect(sockets[0].sent.map((m) => m.id)).toEqual([1, 2]);
    expect(sockets[0].sent[0]).toMatchObject({ jsonrpc: "2.0", method: "session.create", params: { cwd: "C:\\x" } });
    sockets[0].receive({ jsonrpc: "2.0", id: 2, result: { profiles: [] } });
    sockets[0].receive({ jsonrpc: "2.0", id: 1, result: { session_id: "s1" } });
    await expect(a).resolves.toEqual({ session_id: "s1" });
    await expect(b).resolves.toEqual({ profiles: [] });
  });

  it("rejects with HermesRpcError on an error response", async () => {
    const { client, sockets } = await connected();
    const p = client.request("prompt.submit");
    sockets[0].receive({ id: 1, error: { code: -32000, message: "nope" } });
    await expect(p).rejects.toMatchObject({ name: "HermesRpcError", message: "nope", code: -32000 });
  });

  it("times out", async () => {
    const { client } = await connected();
    const p = client.request("slow");
    const assertion = expect(p).rejects.toBeInstanceOf(HermesTimeoutError);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
  });

  it("fails pending requests when the socket drops", async () => {
    const { client, sockets } = await connected();
    const p = client.request("x");
    sockets[0].drop();
    await expect(p).rejects.toBeInstanceOf(HermesDisconnectedError);
    expect(client.connectionStatus).toBe("reconnecting");
  });

  it("connects lazily on the first request", async () => {
    const { client, sockets } = setup();
    const p = client.request("ping");
    expect(sockets).toHaveLength(1);
    sockets[0].open();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].receive({ id: 1, result: {} });
    await expect(p).resolves.toEqual({});
  });

  it("does not retry configuration errors", async () => {
    const { client, sockets } = setup({ token: "" });
    await expect(client.connect()).rejects.toBeInstanceOf(HermesAuthError);
    expect(sockets).toHaveLength(0);
    expect(client.connectionStatus).toBe("closed");
  });
});

describe("HermesClient reconnect", () => {
  it("reconnects with exponential backoff, capped, and resets after success", async () => {
    const { client, sockets } = await connected();
    sockets[0].drop();
    await vi.advanceTimersByTimeAsync(99);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2); // after 100ms
    sockets[1].drop(); // never opened
    await vi.advanceTimersByTimeAsync(200);
    expect(sockets).toHaveLength(3);
    sockets[2].drop();
    await vi.advanceTimersByTimeAsync(400);
    expect(sockets).toHaveLength(4);
    sockets[3].drop();
    await vi.advanceTimersByTimeAsync(400); // capped at 400
    expect(sockets).toHaveLength(5);
    sockets[4].open();
    expect(client.connectionStatus).toBe("connected");
    sockets[4].drop();
    await vi.advanceTimersByTimeAsync(100); // reset to initial delay
    expect(sockets).toHaveLength(6);
  });

  it("close() stops reconnecting and ignores the old socket", async () => {
    const { client, sockets } = await connected();
    client.close();
    expect(sockets[0].closed).toBe(true);
    expect(client.connectionStatus).toBe("closed");
    sockets[0].drop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sockets).toHaveLength(1);
  });
});

describe("events and server requests", () => {
  it("delivers streamed events and normalises request.cancel", async () => {
    const { client, sockets } = await connected();
    const seen: HermesEvent[] = [];
    client.onEvent(null, (e) => seen.push(e));
    sockets[0].receive({ method: "event", params: { type: "message.delta", session_id: "s1", payload: { text: "hi" } } });
    sockets[0].receive({
      method: "event",
      params: { type: "request.cancel", session_id: "s1", payload: { method: "approval", id: "r9", reason: "timeout" } },
    });
    expect(seen.map((e) => e.type)).toEqual(["message.delta", "approval.expire"]);
    expect(seen[1].payload).toEqual({ request_id: "r9", reason: "timeout" });
  });

  it("maps approval/clarify server requests to events", async () => {
    const { client, sockets } = await connected();
    const seen: HermesEvent[] = [];
    client.onEvent("s1", (e) => seen.push(e));
    sockets[0].receive({ id: "srq-1", method: "approval", params: { session_id: "s1", command: "rm x" } });
    sockets[0].receive({
      id: "srq-2",
      method: "clarify",
      params: { session_id: "s1", questions: [{ question: "Which?", choices: ["a", "b"] }] },
    });
    expect(seen[0]).toMatchObject({ type: "approval.request", payload: { server_request_id: "srq-1", command: "rm x" } });
    expect(seen[1]).toMatchObject({
      type: "clarify.request",
      payload: { request_id: "srq-2", question: "Which?", choices: ["a", "b"] },
    });
  });

  it("answers unknown server requests with -32601", async () => {
    const { sockets } = await connected();
    sockets[0].receive({ id: "srq-3", method: "desktop.preview", params: {} });
    expect(sockets[0].sent[0]).toMatchObject({ id: "srq-3", error: { code: -32601 } });
  });

  it("ignores garbage frames", async () => {
    const { sockets } = await connected();
    expect(() => sockets[0].receive("not json")).not.toThrow();
    expect(parseFrame("[1]")).toEqual({ kind: "unknown" });
  });
});

describe("session isolation", () => {
  const ev = (type: string, extra: Partial<HermesEvent> = {}): HermesEvent => ({ type, ...extra });

  it("drops events for other sessions and events with no session id", () => {
    const router = new EventRouter();
    const mine: string[] = [];
    router.subscribe("s1", (e) => mine.push(e.type));
    router.route(ev("a", { session_id: "s1" }));
    router.route(ev("b", { session_id: "s2" }));
    router.route(ev("c")); // no id: fail closed
    router.route(ev("d", { payload: { session_id: "s1" } })); // nested id counts
    router.route(ev("e", { payload: { session_id: "s2" } }));
    expect(mine).toEqual(["a", "d"]);
  });

  it("global listeners see everything; unsubscribe works", () => {
    const router = new EventRouter();
    const all: string[] = [];
    const off = router.subscribe(null, (e) => all.push(e.type));
    router.route(ev("a", { session_id: "s1" }));
    router.route(ev("b"));
    off();
    router.route(ev("c"));
    expect(all).toEqual(["a", "b"]);
  });
});
