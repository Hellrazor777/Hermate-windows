import { beforeEach, describe, expect, it, vi } from "vitest";

// A fake of the Tauri bridge: a plain function (not a spy) behind the mock, and a Channel stand-in.
type Handler = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
let handler: Handler;
const calls: [string, Record<string, unknown>][] = [];
let lastChannel: { onmessage: (e: unknown) => void } | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (e: unknown) => void = () => undefined;
    constructor() {
      lastChannel = this;
    }
  },
  invoke: (cmd: string, args: Record<string, unknown>) => {
    calls.push([cmd, args]);
    return handler(cmd, args);
  },
}));

import { HermesClient } from "./client";
import { TauriWebSocket, tauriWebSocketFactory, type BridgeEvent } from "./tauriSocket";

const emit = (e: BridgeEvent) => lastChannel?.onmessage(e);
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  calls.length = 0;
  lastChannel = null;
  handler = async (cmd) => (cmd === "ws_open" ? 7 : undefined);
});

describe("TauriWebSocket", () => {
  it("opens through ws_open with the url and a channel, and maps events to handlers", async () => {
    const ws = new TauriWebSocket("ws://127.0.0.1:1/api/ws?token=t");
    const seen: string[] = [];
    ws.onopen = () => seen.push("open");
    ws.onmessage = (e) => seen.push(`msg:${e.data}`);
    ws.onerror = () => seen.push("error");
    ws.onclose = () => seen.push("close");
    expect(calls[0][0]).toBe("ws_open");
    expect(calls[0][1].url).toBe("ws://127.0.0.1:1/api/ws?token=t");
    emit({ event: "open" });
    emit({ event: "message", data: "hi" });
    emit({ event: "error", message: "boom" });
    emit({ event: "close", code: 1000, reason: "" });
    emit({ event: "close", code: 1000, reason: "" }); // a duplicate close is ignored
    expect(seen).toEqual(["open", "msg:hi", "error", "close"]);
  });

  it("sends in order, waiting for the socket id", async () => {
    let resolveOpen: (id: number) => void = () => undefined;
    handler = (cmd) => (cmd === "ws_open" ? new Promise<number>((r) => (resolveOpen = r)) : Promise.resolve(undefined));
    const ws = new TauriWebSocket("ws://127.0.0.1:1/api/ws?token=t");
    ws.send("a");
    ws.send("b");
    await flush();
    expect(calls.filter(([c]) => c === "ws_send")).toHaveLength(0); // id not known yet
    resolveOpen(7);
    await flush();
    await flush();
    expect(calls.filter(([c]) => c === "ws_send").map(([, a]) => [a.id, a.text])).toEqual([[7, "a"], [7, "b"]]);
  });

  it("reports a refused ws_open as an error then a single close", async () => {
    handler = async (cmd) => {
      if (cmd === "ws_open") throw "only the Hermes /api/ws endpoint is allowed";
      return undefined;
    };
    const ws = new TauriWebSocket("ws://x/other");
    const seen: string[] = [];
    ws.onerror = (e) => seen.push(`error:${(e as { message: string }).message}`);
    ws.onclose = () => seen.push("close");
    await flush();
    await flush();
    expect(seen).toEqual(["error:only the Hermes /api/ws endpoint is allowed", "close"]);
  });

  it("close() asks Rust to close that socket", async () => {
    const ws = new TauriWebSocket("ws://127.0.0.1:1/api/ws?token=t");
    ws.close();
    await flush();
    expect(calls.some(([c, a]) => c === "ws_close" && a.id === 7)).toBe(true);
  });

  it("a failed send closes the socket instead of throwing", async () => {
    handler = async (cmd) => {
      if (cmd === "ws_open") return 7;
      throw "socket is closed";
    };
    const ws = new TauriWebSocket("ws://127.0.0.1:1/api/ws?token=t");
    const seen: string[] = [];
    ws.onclose = () => seen.push("close");
    ws.send("x");
    await flush();
    await flush();
    expect(seen).toEqual(["close"]);
  });
});

describe("HermesClient over the Tauri socket", () => {
  it("connects through the bridge: handshake, request, response", async () => {
    const client = new HermesClient({ baseUrl: "http://127.0.0.1:4242", token: "tok", webSocketFactory: tauriWebSocketFactory });
    const connecting = client.connect();
    await flush();
    emit({ event: "open" });
    await flush();
    await flush();
    const sent = () => calls.filter(([c]) => c === "ws_send").map(([, a]) => JSON.parse(a.text as string));
    expect(sent()[0]).toMatchObject({ method: "client.capabilities" });
    emit({ event: "message", data: JSON.stringify({ id: sent()[0].id, result: {} }) });
    await connecting;
    expect(client.connectionStatus).toBe("connected");
    expect(calls[0][1].url).toBe("ws://127.0.0.1:4242/api/ws?token=tok");
    client.close();
  });
});
