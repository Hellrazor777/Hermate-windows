import { eventForServerRequest, parseFrame } from "./frames";
import { EventRouter, type EventHandler } from "./router";
import {
  HermesAuthError,
  HermesDisconnectedError,
  HermesRpcError,
  HermesTimeoutError,
  type ConnectionStatus,
  type JsonObject,
} from "./types";

/** The subset of the browser WebSocket the client uses; lets tests inject a fake. */
export type ApprovalChoice = "once" | "session" | "always" | "deny";

export interface WebSocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface HermesClientOptions {
  /** Base URL of Hermes, e.g. `http://127.0.0.1:9119` (loopback / SSH-forwarded) or `https://host` (remote -> wss). */
  baseUrl: string;
  /** Session token. Held in memory only; callers load it from Windows Credential Manager. */
  token: string;
  /** Default per-request timeout. */
  requestTimeoutMs?: number;
  reconnect?: { initialDelayMs?: number; maxDelayMs?: number };
  /** `gateway.ping` keepalive. Hermes' own clients use a 45s deadline; a missed pong drops the socket and reconnects. */
  heartbeat?: { intervalMs?: number; timeoutMs?: number };
  /** Test seam. */
  webSocketFactory?: (url: string) => WebSocketLike;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const NORMAL_CLOSURE = 1000;

/**
 * Build the `/api/ws` URL. The token goes in the query (the browser WebSocket API cannot
 * set an Authorization header, and Hermes' `/api/ws` handler rejects header-only auth).
 * `encodeURIComponent` encodes `+`, which Hermes would otherwise decode as a space.
 */
export function buildWebSocketUrl(baseUrl: string, token: string): string {
  if (token === "" || /[\r\n]/.test(token)) throw new HermesAuthError();
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HermesRpcError(`Unsupported Hermes URL scheme: ${url.protocol}`);
  }
  const scheme = url.protocol === "https:" ? "wss:" : "ws:";
  const path = url.pathname.replace(/\/+$/, "");
  return `${scheme}//${url.host}${path}/api/ws?token=${encodeURIComponent(token)}`;
}

interface Pending {
  method: string;
  resolve: (value: JsonObject) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** WebSocket JSON-RPC client for Hermes `/api/ws`. Not verified against a live install yet (issue #3). */
export class HermesClient {
  readonly events = new EventRouter();

  private readonly opts: HermesClientOptions;
  private socket: WebSocketLike | null = null;
  private status: ConnectionStatus = "idle";
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private serverRequestsAdvertised = false;
  private statusListeners = new Set<(status: ConnectionStatus) => void>();
  private connectWaiters: { resolve: () => void; reject: (e: unknown) => void }[] = [];

  constructor(opts: HermesClientOptions) {
    this.opts = opts;
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /** Subscribe to events for one session (isolated) or `null` for all events. */
  onEvent(sessionId: string | null, handler: EventHandler): () => void {
    return this.events.subscribe(sessionId, handler);
  }

  /** Open the socket. Resolves once connected; rejects on the first failure (and keeps retrying in the background). */
  connect(): Promise<void> {
    if (this.status === "connected") return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.connectWaiters.push({ resolve, reject });
      if (this.status === "idle" || this.status === "closed") {
        this.setStatus("connecting");
        this.open();
      }
    });
  }

  async request(method: string, params: JsonObject = {}, timeoutMs?: number): Promise<JsonObject> {
    if (this.status === "idle" || this.status === "closed") await this.connect();
    const socket = this.socket;
    if (!socket || this.status !== "connected") throw new HermesDisconnectedError();
    return this.send(socket, method, params, timeoutMs);
  }

  /**
   * Answer a server->client request by replying with a JSON-RPC response frame carrying the
   * same `srq-…` id. This is how Hermes expects approval and clarify answers (verified in the
   * server source; see docs/PROTOCOL.md). A reply for a request that already ended is dropped by the server.
   */
  respondToServerRequest(id: string, result: JsonObject): void {
    if (!this.socket || this.status !== "connected") throw new HermesDisconnectedError();
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  /** Answer an `approval.request` event (use its `payload.server_request_id`). */
  answerApproval(serverRequestId: string, choice: ApprovalChoice, all = false): void {
    this.respondToServerRequest(serverRequestId, all ? { choice, all: true } : { choice });
  }

  /**
   * Answer a `clarify.request` event (use its `payload.request_id`) with `answers` keyed by question id.
   * Hermes wants strings: a multi-select answer is joined with ", " (as Hermes' own adapter does) and
   * `null` skips a question. Shape read from the Hermes source (`settle_batch`); not exercised live.
   */
  answerClarify(requestId: string, answers: Record<string, string | string[] | null>): void {
    const wire: Record<string, string | null> = {};
    for (const [qid, value] of Object.entries(answers)) wire[qid] = Array.isArray(value) ? value.join(", ") : value;
    this.respondToServerRequest(requestId, { answers: wire });
  }

  /** Dismiss a clarify request without answering: an empty result is treated by Hermes as a cancel. */
  declineClarify(requestId: string): void {
    this.respondToServerRequest(requestId, {});
  }

  /** Close for good: no reconnect, pending requests fail. */
  close(): void {
    this.clearReconnect();
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      detach(socket);
      socket.close(NORMAL_CLOSURE);
    }
    this.failPending(new HermesDisconnectedError());
    this.rejectWaiters(new HermesDisconnectedError());
    this.setStatus("closed");
  }

  // --- internals ---

  private send(socket: WebSocketLike, method: string, params: JsonObject, timeoutMs?: number): Promise<JsonObject> {
    const id = ++this.nextId;
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HermesTimeoutError(method));
      }, timeoutMs ?? this.opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  /** Tell Hermes this connection answers server requests; otherwise it never sends them and the agent waits out its deadline. */
  private handshake(socket: WebSocketLike): void {
    const markConnected = (serverRequests: boolean) => {
      if (this.socket !== socket) return;
      this.serverRequestsAdvertised = serverRequests;
      this.attempt = 0;
      this.setStatus("connected");
      this.startHeartbeat(socket);
      const waiters = this.connectWaiters;
      this.connectWaiters = [];
      waiters.forEach((w) => w.resolve());
    };
    this.send(socket, "client.capabilities", { server_requests: true }).then(
      () => markConnected(true),
      (e) => {
        // A backend that rejects the method is older: connect anyway, but fail closed on server requests.
        if (e instanceof HermesRpcError && !(e instanceof HermesDisconnectedError) && !(e instanceof HermesTimeoutError)) {
          markConnected(false);
        } else {
          this.handleDrop(socket);
        }
      },
    );
  }

  /** True when Hermes accepted `client.capabilities {server_requests:true}` on the current connection. */
  get serverRequestsEnabled(): boolean {
    return this.status === "connected" && this.serverRequestsAdvertised;
  }

  private startHeartbeat(socket: WebSocketLike): void {
    this.stopHeartbeat();
    const { intervalMs = 20_000, timeoutMs = 10_000 } = this.opts.heartbeat ?? {};
    this.heartbeatTimer = setInterval(() => {
      this.send(socket, "gateway.ping", {}, timeoutMs).catch(() => this.handleDrop(socket));
    }, intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /** The socket is gone or unresponsive: tear it down once and schedule a reconnect. */
  private handleDrop(socket: WebSocketLike): void {
    if (this.socket !== socket) return; // a replaced/closed socket's drop is not a drop
    this.socket = null;
    this.stopHeartbeat();
    detach(socket);
    try {
      socket.close();
    } catch {
      /* already closed */
    }
    this.failPending(new HermesDisconnectedError());
    this.rejectWaiters(new HermesDisconnectedError());
    this.scheduleReconnect();
  }

  private open(): void {
    let socket: WebSocketLike;
    try {
      const url = buildWebSocketUrl(this.opts.baseUrl, this.opts.token);
      socket = this.opts.webSocketFactory
        ? this.opts.webSocketFactory(url)
        : (new WebSocket(url) as unknown as WebSocketLike);
    } catch (e) {
      // Configuration errors (missing token, bad URL) will not fix themselves: do not retry.
      this.rejectWaiters(e);
      this.setStatus("closed");
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket === socket) this.handshake(socket);
    };
    socket.onmessage = (ev) => {
      if (this.socket === socket && typeof ev.data === "string") this.handleFrame(ev.data);
    };
    socket.onerror = () => {
      /* a close always follows; handled there */
    };
    socket.onclose = () => this.handleDrop(socket);
  }

  private handleFrame(text: string): void {
    const frame = parseFrame(text);
    switch (frame.kind) {
      case "response": {
        const p = this.pending.get(frame.id);
        if (!p) return;
        this.pending.delete(frame.id);
        clearTimeout(p.timer);
        if (frame.error) p.reject(new HermesRpcError(frame.error.message, frame.error.code, frame.error.data));
        else p.resolve(frame.result ?? {});
        return;
      }
      case "serverRequest": {
        const event = eventForServerRequest(frame);
        if (event) {
          this.events.route(event);
        } else {
          // Unhandled requests must not park the agent until its deadline.
          this.socket?.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: frame.id,
              error: { code: -32601, message: `Hermate does not handle ${frame.method} requests` },
            }),
          );
        }
        return;
      }
      case "event":
        this.events.route(frame.event);
        return;
      default:
        return;
    }
  }

  private scheduleReconnect(): void {
    this.setStatus("reconnecting");
    const { initialDelayMs = 1000, maxDelayMs = 30_000 } = this.opts.reconnect ?? {};
    const delay = Math.min(initialDelayMs * 2 ** this.attempt, maxDelayMs);
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.status === "reconnecting") this.open();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private failPending(error: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }

  private rejectWaiters(error: unknown): void {
    const waiters = this.connectWaiters;
    this.connectWaiters = [];
    waiters.forEach((w) => w.reject(error));
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.statusListeners.forEach((l) => l(status));
  }
}

function detach(socket: WebSocketLike): void {
  socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
}
