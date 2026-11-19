import { useEffect, useState, useSyncExternalStore } from "react";
import type { CronJob, CronStore } from "./store";

const when = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

/** Scheduled jobs on the connected Hermes: list, add, pause/resume, delete. */
export default function CronPanel({ store }: { store: CronStore }) {
  const { jobs, loading, error } = useSyncExternalStore(store.subscribe, store.get);
  const [name, setName] = useState("");
  const [schedule, setSchedule] = useState("");
  const [prompt, setPrompt] = useState("");
  const [repeat, setRepeat] = useState("");

  useEffect(() => {
    void store.refresh();
  }, [store]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const times = repeat.trim() ? Number(repeat) : undefined;
    if (await store.add({ name, schedule, prompt, repeat: times })) {
      setName("");
      setSchedule("");
      setPrompt("");
      setRepeat("");
    }
  }

  function remove(job: CronJob) {
    if (window.confirm(`Delete the scheduled job “${job.name}”? This cannot be undone.`)) void store.remove(job.id);
  }

  return (
    <section aria-label="Scheduled jobs">
      <h2>Scheduled jobs</h2>
      <button disabled={loading} onClick={() => void store.refresh()}>
        {loading ? "Loading…" : "Refresh"}
      </button>
      {error && <p role="alert">{error}</p>}
      {!loading && !error && jobs.length === 0 && <p className="muted">No scheduled jobs.</p>}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {jobs.map((job) => (
          <li key={job.id} style={{ margin: "8px 0" }}>
            <strong>{job.name}</strong> <span className="muted">{job.enabled ? job.state : "paused"} · {job.schedule}</span>{" "}
            {job.enabled ? (
              <button aria-label={`Pause ${job.name}`} onClick={() => void store.pause(job.id)}>
                Pause
              </button>
            ) : (
              <button aria-label={`Resume ${job.name}`} onClick={() => void store.resume(job.id)}>
                Resume
              </button>
            )}{" "}
            <button aria-label={`Delete ${job.name}`} onClick={() => remove(job)}>
              Delete
            </button>
            <div className="muted">
              {job.promptPreview}
              <br />
              Next run: {job.enabled ? when(job.nextRunAt) : "paused"} · Last run: {when(job.lastRunAt)}
              {job.lastStatus ? ` (${job.lastStatus})` : ""} · Repeat: {job.repeat}
              {job.lastError ? ` · Last error: ${job.lastError}` : ""}
            </div>
          </li>
        ))}
      </ul>

      <form onSubmit={add}>
        <fieldset>
          <legend>Add a scheduled job</legend>
          <label>
            Name <input aria-label="Job name" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Schedule{" "}
            <input
              aria-label="Schedule"
              value={schedule}
              placeholder="every 2h · weekdays at 9am · 0 9 * * *"
              onChange={(e) => setSchedule(e.target.value)}
            />
          </label>
          <label>
            Repeat times{" "}
            <input aria-label="Repeat times" value={repeat} placeholder="forever" onChange={(e) => setRepeat(e.target.value)} />
          </label>
          <label>
            What Hermes should do
            <textarea aria-label="Job prompt" rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>
          <p className="muted">Output is saved on the Hermes machine; it is not delivered anywhere.</p>
          <button type="submit">Add job</button>
        </fieldset>
      </form>
    </section>
  );
}
