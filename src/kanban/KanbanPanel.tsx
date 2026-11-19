import { useEffect, useState, useSyncExternalStore } from "react";
import type { KanbanStore, KanbanTask, TaskMove } from "./store";

const MOVES: { to: TaskMove; label: string; from?: string[] }[] = [
  { to: "ready", label: "Ready", from: ["todo", "blocked", "scheduled", "triage", "review"] },
  { to: "blocked", label: "Block", from: ["todo", "ready", "scheduled", "triage"] },
  { to: "done", label: "Complete", from: ["todo", "ready", "blocked", "scheduled", "review"] },
  { to: "archived", label: "Archive", from: ["done", "blocked", "todo", "ready", "triage", "review", "scheduled"] },
];

const when = (s: number | null) => (s ? new Date(s * 1000).toLocaleString() : "");

/** The Kanban board on the connected Hermes: view, add tasks, comment, and move a task along. */
export default function KanbanPanel({ store }: { store: KanbanStore }) {
  const { boards, board, columns, assignees, detail, loading, error } = useSyncExternalStore(store.subscribe, store.get);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [assignee, setAssignee] = useState("");
  const [comment, setComment] = useState("");
  const [completing, setCompleting] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    void store.refresh();
  }, [store]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (await store.create({ title, body, assignee: assignee || undefined })) {
      setTitle("");
      setBody("");
      setAssignee("");
    }
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (detail && (await store.comment(detail.task.id, comment))) setComment("");
  }

  // A completion note belongs to one task: forget it when another is opened or this one moves.
  const shownId = detail?.task.id;
  const shownStatus = detail?.task.status;
  useEffect(() => {
    setCompleting(false);
    setNote("");
  }, [shownId, shownStatus]);

  async function complete(e: React.FormEvent) {
    e.preventDefault();
    if (detail) await store.move(detail.task.id, "done", note);
  }

  function archive(t: KanbanTask) {
    if (window.confirm(`Archive “${t.title}”? It leaves the board.`)) void store.move(t.id, "archived");
  }

  const total = columns.reduce((n, c) => n + c.tasks.length, 0);

  return (
    <section aria-label="Kanban">
      <h2>Kanban</h2>
      {boards.length > 1 && (
        <label>
          Board{" "}
          <select aria-label="Board" value={board ?? ""} onChange={(e) => void store.selectBoard(e.target.value)}>
            {boards.map((b) => (
              <option key={b.slug} value={b.slug}>
                {b.name} ({b.total})
              </option>
            ))}
          </select>{" "}
        </label>
      )}
      <button disabled={loading} onClick={() => void store.refresh()}>
        {loading ? "Loading…" : "Refresh"}
      </button>
      {error && <p role="alert">{error}</p>}
      {!loading && !error && board === null && <p className="muted">No Kanban board on this Hermes.</p>}
      {board !== null && !loading && total === 0 && !error && <p className="muted">No tasks on this board.</p>}

      {columns
        .filter((c) => c.tasks.length > 0)
        .map((c) => (
          <div key={c.name} role="group" aria-label={`${c.name} tasks`}>
            <h3>
              {c.name} <span className="muted">({c.tasks.length})</span>
            </h3>
            <ul style={{ listStyle: "none", padding: 0 }}>
              {c.tasks.map((t) => (
                <li key={t.id} style={{ margin: "6px 0" }}>
                  <button aria-label={`Open ${t.title}`} onClick={() => void store.open(t.id)}>
                    {t.title}
                  </button>{" "}
                  <span className="muted">
                    {t.assignee ?? "unassigned"}
                    {t.commentCount > 0 ? ` · ${t.commentCount} comment${t.commentCount === 1 ? "" : "s"}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}

      {detail && (
        <article aria-label="Task details">
          <h3>{detail.task.title}</h3>
          <p className="muted">
            {detail.task.status} · {detail.task.assignee ?? "unassigned"} · {detail.task.id}
          </p>
          {detail.task.body && <p style={{ whiteSpace: "pre-wrap" }}>{detail.task.body}</p>}
          {detail.task.result && (
            <p style={{ whiteSpace: "pre-wrap" }}>
              <strong>Result:</strong> {detail.task.result}
            </p>
          )}
          <div>
            {MOVES.filter((m) => m.to !== detail.task.status && (!m.from || m.from.includes(detail.task.status))).map((m) => (
              <button
                key={m.to}
                onClick={() => (m.to === "archived" ? archive(detail.task) : m.to === "done" ? setCompleting(true) : void store.move(detail.task.id, m.to))}
              >
                {m.label}
              </button>
            ))}{" "}
            <button onClick={() => store.close()}>Close</button>
          </div>
          {completing && (
            <form onSubmit={complete}>
              <input aria-label="Completion note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was done?" />{" "}
              <button type="submit">Confirm complete</button> <button type="button" onClick={() => setCompleting(false)}>Cancel</button>
            </form>
          )}
          <h4>Comments</h4>
          {detail.comments.length === 0 && <p className="muted">No comments.</p>}
          <ul style={{ listStyle: "none", padding: 0 }}>
            {detail.comments.map((c) => (
              <li key={c.id}>
                <strong>{c.author}</strong> <span className="muted">{when(c.createdAt)}</span>
                <div style={{ whiteSpace: "pre-wrap" }}>{c.body}</div>
              </li>
            ))}
          </ul>
          <form onSubmit={send}>
            <input aria-label="Comment" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment" />{" "}
            <button type="submit">Comment</button>
          </form>
        </article>
      )}

      {board !== null && (
        <form onSubmit={add}>
          <fieldset>
            <legend>Add a task</legend>
            <label>
              Title <input aria-label="Task title" value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label>
              Assignee{" "}
              <select aria-label="Assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">Unassigned</option>
                {assignees.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Details
              <textarea aria-label="Task details text" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
            </label>
            <button type="submit">Add task</button>
          </fieldset>
        </form>
      )}
    </section>
  );
}
