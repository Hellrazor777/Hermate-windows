import { useEffect, useSyncExternalStore } from "react";
import type { ChatController } from "../chat/controller";
import type { SessionList, SessionSummary } from "./list";

const when = (s: SessionSummary) => (s.startedAt ? new Date(s.startedAt * 1000).toLocaleString() : "");

/** Past sessions on the connected Hermes: open one, start a new chat, or delete one. */
export default function SessionsPanel({ list, chat }: { list: SessionList; chat: ChatController }) {
  const { sessions, loading, error } = useSyncExternalStore(list.subscribe, list.get);
  const { storedId, running } = useSyncExternalStore(chat.subscribe, chat.get);

  // On mount, and whenever a turn finishes (that is when a new session gets its title and message count).
  useEffect(() => {
    if (!running) void list.refresh();
  }, [list, running]);

  async function remove(s: SessionSummary) {
    if (!window.confirm(`Delete “${s.title}” permanently? This cannot be undone.`)) return;
    // Hermes refuses to delete an open session: leave it first.
    if (s.id === storedId) await chat.newSession();
    await list.remove(s.id);
  }

  return (
    <section aria-label="Sessions">
      <h2>Sessions</h2>
      <button disabled={running} onClick={() => void chat.newSession()}>
        New chat
      </button>{" "}
      <button disabled={loading} onClick={() => void list.refresh()}>
        {loading ? "Loading…" : "Refresh"}
      </button>
      {error && <p role="alert">{error}</p>}
      {!loading && !error && sessions.length === 0 && <p className="muted">No sessions yet.</p>}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {sessions.map((s) => {
          const open = s.id === storedId;
          return (
            <li key={s.id} style={{ margin: "6px 0" }} aria-current={open ? "true" : undefined}>
              <button disabled={running || open} onClick={() => void chat.open(s.id)} title={s.preview}>
                <strong>{s.title}</strong>
              </button>{" "}
              <span className="muted">
                {when(s)} · {s.messageCount} messages{open ? " · open" : ""}
              </span>{" "}
              <button aria-label={`Delete ${s.title}`} disabled={running && open} onClick={() => void remove(s)}>
                Delete
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
