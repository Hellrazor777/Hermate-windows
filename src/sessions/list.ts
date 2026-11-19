import type { HermesClient } from "../rpc";

/** One stored session as `session.list` reports it (verified live; see docs/PROTOCOL.md). */
export interface SessionSummary {
  /** The stored id: what `session.resume` and `session.delete` take. */
  id: string;
  title: string;
  preview: string;
  /** Epoch seconds. */
  startedAt: number;
  messageCount: number;
  source: string;
}

export type SessionsClient = Pick<HermesClient, "request">;

export interface SessionsSnapshot {
  sessions: SessionSummary[];
  loading: boolean;
  error: string | null;
}

const LIMIT = 50;

/** Keep only well-formed entries, newest first. Hermes is authoritative; this is a view of its list. */
export function parseSessions(raw: unknown): SessionSummary[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionSummary[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (typeof o.id !== "string" || o.id === "") continue;
    out.push({
      id: o.id,
      title: typeof o.title === "string" && o.title.trim() ? o.title : "Untitled",
      preview: typeof o.preview === "string" ? o.preview : "",
      startedAt: typeof o.started_at === "number" && Number.isFinite(o.started_at) ? o.started_at : 0,
      messageCount: typeof o.message_count === "number" && Number.isFinite(o.message_count) ? o.message_count : 0,
      source: typeof o.source === "string" ? o.source : "",
    });
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/** The list of past sessions on the connected Hermes. */
export class SessionList {
  private snapshot: SessionsSnapshot = { sessions: [], loading: false, error: null };
  private listeners = new Set<() => void>();
  private disposed = false;
  /** A refresh that lost to a newer one must not overwrite the newer result. */
  private latest = 0;

  constructor(private readonly client: SessionsClient) {}

  get = (): SessionsSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async refresh(): Promise<void> {
    const mine = ++this.latest;
    this.set({ loading: true });
    try {
      const res = await this.client.request("session.list", { limit: LIMIT });
      if (mine === this.latest) this.set({ sessions: parseSessions(res.sessions), loading: false, error: null });
    } catch (e) {
      if (mine === this.latest) this.set({ loading: false, error: e instanceof Error ? e.message : "Could not load sessions." });
    }
  }

  /** Delete a stored session permanently. Hermes refuses one that is still open (error 4023). */
  async remove(id: string): Promise<boolean> {
    try {
      await this.client.request("session.delete", { session_id: id });
    } catch (e) {
      this.set({ error: e instanceof Error ? e.message : "Could not delete the session." });
      return false;
    }
    this.set({ sessions: this.snapshot.sessions.filter((s) => s.id !== id), error: null });
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private set(patch: Partial<SessionsSnapshot>): void {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }
}
