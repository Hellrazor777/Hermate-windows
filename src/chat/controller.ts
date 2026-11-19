import type { HermesClient } from "../rpc";
import { addUserMessage, initialChatState, reduce, type ChatItem, type ChatState } from "./state";

/** The slice of the RPC client the controller uses; tests pass a fake. */
export type ChatClient = Pick<HermesClient, "request" | "onEvent">;

export interface ChatSnapshot extends ChatState {
  /** The live id Hermes uses for streaming and prompts. */
  sessionId: string | null;
  /** The stored id that `session.list` shows, for highlighting the open session. */
  storedId: string | null;
  /** Hermes sent only the tail of a long history when the session was opened. */
  truncated: boolean;
}

const EMPTY: ChatSnapshot = { ...initialChatState, sessionId: null, storedId: null, truncated: false };

/**
 * One chat session over a Hermes connection. Events are subscribed per session id, so frames
 * from any other session are dropped by the router (session isolation); the transcript is a pure
 * projection of what Hermes sends.
 */
export class ChatController {
  private snapshot: ChatSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private starting: Promise<string> | null = null;
  /** Bumped on every session switch so a slow `create`/`resume` that lost the race is discarded. */
  private generation = 0;

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
    const generation = this.generation;
    this.starting ??= this.client
      .request("session.create", {})
      .then(async (res) => {
        const id = res.session_id;
        if (typeof id !== "string" || id === "") throw new Error("Hermes did not return a session id.");
        if (generation !== this.generation) {
          // The user switched sessions while this one was being created: release it.
          await this.client.request("session.close", { session_id: id }).catch(() => undefined);
          throw new Error("The session changed while it was starting.");
        }
        this.attach(id);
        this.set({ sessionId: id, storedId: typeof res.stored_session_id === "string" ? res.stored_session_id : null });
        return id;
      })
      .finally(() => {
        if (generation === this.generation) this.starting = null;
      });
    return this.starting;
  }

  /** Subscribe before anything is sent so no event of the first turn can be missed. */
  private attach(liveId: string): void {
    this.unsubscribe?.();
    this.unsubscribe = this.client.onEvent(liveId, (event) => this.set({ ...reduce(this.snapshot, event), sessionId: liveId }));
  }

  /** Leave the current session: stop listening, release it in Hermes (best effort) and clear the transcript. */
  private async leave(): Promise<void> {
    this.generation++;
    this.starting = null; // a create still in flight is stale now; it releases itself when it lands
    const id = this.snapshot.sessionId;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.snapshot = EMPTY;
    this.emit();
    if (id) await this.client.request("session.close", { session_id: id }).catch(() => undefined);
  }

  /** Start over with an empty chat; Hermes creates the session on the first message. */
  async newSession(): Promise<void> {
    if (this.snapshot.running) return;
    await this.leave();
  }

  /**
   * Open a stored session from history. `storedId` is the id `session.list` shows; Hermes answers with a
   * new live id and the messages so far. Refused while a turn is running, so no reply is cut off.
   */
  async open(storedId: string): Promise<void> {
    if (this.snapshot.running || storedId === this.snapshot.storedId) return;
    await this.leave();
    const generation = this.generation;
    try {
      const res = await this.client.request("session.resume", { session_id: storedId });
      const liveId = res.session_id;
      if (typeof liveId !== "string" || liveId === "") throw new Error("Hermes did not return a session id.");
      if (generation !== this.generation) {
        await this.client.request("session.close", { session_id: liveId }).catch(() => undefined);
        return;
      }
      this.attach(liveId);
      this.set({
        items: transcriptFromHistory(res.messages),
        sessionId: liveId,
        storedId: typeof res.resumed === "string" ? res.resumed : storedId,
        truncated: res.messages_omitted === true,
        running: res.running === true, // a turn still in flight: its events continue to arrive
        error: null,
      });
    } catch (e) {
      if (generation === this.generation) this.set({ error: e instanceof Error ? e.message : "Could not open the session." });
    }
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
    this.emit();
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }
}

/**
 * The transcript of a resumed session. Only user and assistant text is kept: Hermes' stored messages for
 * other roles (tool results, system prompts) can be large or sensitive and are not shown. Ids carry the
 * stored row id, so they cannot collide with the ids of live turns.
 */
export function transcriptFromHistory(messages: unknown): ChatItem[] {
  if (!Array.isArray(messages)) return [];
  const items: ChatItem[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const { role, text, row_id } = m as Record<string, unknown>;
    if (typeof text !== "string" || text === "") continue;
    const id = typeof row_id === "number" || typeof row_id === "string" ? String(row_id) : `h${items.length}`;
    if (role === "user") items.push({ kind: "user", id: `user:${id}`, text });
    else if (role === "assistant") items.push({ kind: "assistant", id: `history:${id}`, text, sealed: true });
  }
  return items;
}
