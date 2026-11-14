import type { HermesEvent } from "./types";

export type EventHandler = (event: HermesEvent) => void;

/** The session an event claims to belong to: top-level `session_id`, else `payload.session_id`. */
export function eventSessionId(event: HermesEvent): string | undefined {
  if (typeof event.session_id === "string" && event.session_id !== "") return event.session_id;
  const nested = event.payload?.session_id;
  return typeof nested === "string" && nested !== "" ? nested : undefined;
}

/**
 * Session isolation: a handler bound to a session only sees events that prove they
 * belong to it. Events with no session id, or another id, are dropped (fail closed).
 * A handler with `sessionId === null` is a global listener and sees everything.
 */
export class EventRouter {
  private nextId = 0;
  private subs = new Map<number, { sessionId: string | null; handler: EventHandler }>();

  /** Returns an unsubscribe function. */
  subscribe(sessionId: string | null, handler: EventHandler): () => void {
    const id = this.nextId++;
    this.subs.set(id, { sessionId, handler });
    return () => {
      this.subs.delete(id);
    };
  }

  route(event: HermesEvent): void {
    const owner = eventSessionId(event);
    for (const sub of [...this.subs.values()]) {
      if (sub.sessionId !== null && sub.sessionId !== owner) continue;
      sub.handler(event);
    }
  }
}
