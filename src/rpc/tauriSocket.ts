import { Channel, invoke } from "@tauri-apps/api/core";
import type { WebSocketLike } from "./client";

/** What the Rust side (`ws_bridge.rs`) streams for one socket. */
export type BridgeEvent =
  | { event: "open" }
  | { event: "message"; data: string }
  | { event: "close"; code: number | null; reason: string }
  | { event: "error"; message: string };

/**
 * A WebSocket that lives in Rust. Hermes refuses a browser-side socket (its Origin gate answers 403 to
 * a webview's origin), so inside Tauri the connection is opened natively, with no Origin, and its
 * frames are streamed here. Same surface as the browser WebSocket the client already uses.
 *
 * The URL contains the token and is only ever passed to `ws_open`; it is never kept or logged here.
 */
export class TauriWebSocket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  private id: Promise<number>;
  /** Sends run in order, after the socket id is known. */
  private queue: Promise<unknown>;
  private finished = false;

  constructor(url: string) {
    const channel = new Channel<BridgeEvent>();
    channel.onmessage = (e) => this.handle(e);
    this.id = invoke<number>("ws_open", { url, onEvent: channel });
    this.queue = this.id.catch(() => undefined);
    this.id.catch((e: unknown) => {
      // ws_open refused (bad URL, too many sockets): report it as a failed connection.
      this.handle({ event: "error", message: typeof e === "string" ? e : "could not open the connection" });
      this.handle({ event: "close", code: null, reason: "" });
    });
  }

  send(data: string): void {
    this.queue = this.queue.then(async () => {
      if (this.finished) return;
      try {
        await invoke("ws_send", { id: await this.id, text: data });
      } catch {
        this.handle({ event: "close", code: null, reason: "" });
      }
    });
  }

  close(): void {
    // Handlers are normally detached by the client before this; the Rust side confirms with a close event.
    void this.id.then((id) => invoke("ws_close", { id })).catch(() => undefined);
  }

  private handle(e: BridgeEvent): void {
    switch (e.event) {
      case "open":
        this.onopen?.({});
        return;
      case "message":
        this.onmessage?.({ data: e.data });
        return;
      case "error":
        this.onerror?.({ message: e.message });
        return;
      case "close":
        if (this.finished) return; // exactly one close
        this.finished = true;
        this.onclose?.({ code: e.code, reason: e.reason });
        return;
    }
  }
}

/** Use for `HermesClientOptions.webSocketFactory` inside the Tauri app. */
export const tauriWebSocketFactory = (url: string): WebSocketLike => new TauriWebSocket(url);
