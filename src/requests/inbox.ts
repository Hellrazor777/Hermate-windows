import type { HermesClient } from "../rpc";
import { reduceRequests, type PendingRequest } from "./state";

/** The slice of the RPC client the inbox uses; tests pass a fake. */
export type RequestClient = Pick<HermesClient, "onEvent" | "answerApproval" | "answerClarify" | "declineClarify">;

export interface InboxSnapshot {
  pending: PendingRequest[];
  /** The last answer that could not be sent (for example the connection dropped). */
  error: string | null;
}

/**
 * Collects the approval and clarify questions of every session on one connection (a global
 * listener: a blocked agent matters even when its chat is not on screen) and answers them.
 * A request leaves the list only once its answer was written to the socket, or Hermes withdrew it.
 */
export class RequestInbox {
  private snapshot: InboxSnapshot = { pending: [], error: null };
  private listeners = new Set<() => void>();
  private off: () => void;

  constructor(private readonly client: RequestClient) {
    this.off = client.onEvent(null, (event) => {
      const pending = reduceRequests(this.snapshot.pending, event);
      if (pending !== this.snapshot.pending) this.set({ pending });
    });
  }

  get = (): InboxSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** `choice` must be one Hermes offered for this request. */
  approve(id: string, choice: string, all = false): void {
    const req = this.find(id, "approval");
    if (!req) return;
    if (!req.choices.includes(choice)) return this.set({ error: "That answer is not allowed for this request." });
    this.answer(id, () => this.client.answerApproval(id, choice as Parameters<RequestClient["answerApproval"]>[1], all));
  }

  answerClarify(id: string, answers: Record<string, string | string[] | null>): void {
    if (!this.find(id, "clarify")) return;
    this.answer(id, () => this.client.answerClarify(id, answers));
  }

  skipClarify(id: string): void {
    if (!this.find(id, "clarify")) return;
    this.answer(id, () => this.client.declineClarify(id));
  }

  dismissError(): void {
    this.set({ error: null });
  }

  dispose(): void {
    this.off();
    this.listeners.clear();
  }

  private find<K extends PendingRequest["kind"]>(id: string, kind: K): Extract<PendingRequest, { kind: K }> | undefined {
    return this.snapshot.pending.find((r): r is Extract<PendingRequest, { kind: K }> => r.id === id && r.kind === kind);
  }

  private answer(id: string, send: () => void): void {
    try {
      send();
    } catch (e) {
      // Keep the request visible: it is still blocking the agent.
      return this.set({ error: e instanceof Error ? e.message : "Could not send the answer." });
    }
    this.set({ pending: this.snapshot.pending.filter((r) => r.id !== id), error: null });
  }

  private set(patch: Partial<InboxSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }
}
