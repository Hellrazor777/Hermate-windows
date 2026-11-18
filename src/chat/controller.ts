import type { HermesClient } from "../rpc";
import { addUserMessage, initialChatState, reduce, type ChatState } from "./state";

/** The slice of the RPC client the controller uses; tests pass a fake. */
export type ChatClient = Pick<HermesClient, "request" | "onEvent">;

export interface ChatSnapshot extends ChatState {
  sessionId: string | null;
}

/**
 * One chat session over a Hermes connection. Events are subscribed per session id, so frames
 * from any other session are dropped by the router (session isolation); the transcript is a pure
 * projection of what Hermes sends.
 */
export class ChatController {
  private snapshot: ChatSnapshot = { ...initialChatState, sessionId: null };
  private listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private starting: Promise<string> | null = null;

  constructor(private readonly client: ChatClient) {}

  get = (): ChatSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Create the Hermes session on first use. */
  private ensureSession(): Promise<string> {
    if (this.snapshot.sessionId) return Promise.resolve(this.snapshot.sessionId);
    this.starting ??= this.client
      .request("session.create", {})
      .then((res) => {
        const id = res.session_id;
        if (typeof id !== "string" || id === "") throw new Error("Hermes did not return a session id.");
        // Subscribe before returning so no event of the first turn can be missed.
        this.unsubscribe = this.client.onEvent(id, (event) => this.set({ ...reduce(this.snapshot, event), sessionId: id }));
        this.set({ sessionId: id });
        return id;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  /** Send a prompt. Resolves once Hermes accepted it; the reply streams in through events. */
  async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.snapshot.running) return;
    try {
      const sessionId = await this.ensureSession();
      const res = await this.client.request("prompt.submit", { session_id: sessionId, text: trimmed });
      // Add the user row only now that Hermes accepted it (Hermes is authoritative); its row id is the key.
      const rowId = typeof res.user_row_id === "number" || typeof res.user_row_id === "string" ? String(res.user_row_id) : `local-${Date.now()}`;
      this.set(addUserMessage(this.snapshot, `user:${rowId}`, trimmed));
    } catch (e) {
      this.set({ error: e instanceof Error ? e.message : "Could not send the message." });
    }
  }

  async interrupt(): Promise<void> {
    const id = this.snapshot.sessionId;
    if (!id || !this.snapshot.running) return;
    try {
      await this.client.request("session.interrupt", { session_id: id });
    } catch (e) {
      this.set({ error: e instanceof Error ? e.message : "Could not stop the turn." });
    }
  }

  /** Stop listening and tell Hermes to release the session (best effort: the connection may already be gone). */
  async close(): Promise<void> {
    const id = this.snapshot.sessionId;
    this.dispose();
    if (id) await this.client.request("session.close", { session_id: id }).catch(() => undefined);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
  }

  private set(patch: Partial<ChatSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }
}
