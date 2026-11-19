import { describe, expect, it } from "vitest";
import { CronStore, parseJobs, validateNewJob, type CronClient } from "./store";

/** A row exactly as `cron.manage` returned it live. */
const row = (over: Record<string, unknown> = {}) => ({
  job_id: "487f141b762b",
  name: "hermate-probe-job",
  skill: null,
  skills: [],
  prompt_preview: "probe only: say hi",
  schedule: "0 0 1 1 *",
  repeat: "forever",
  deliver: "local",
  next_run_at: "2027-01-01T00:00:00+11:00",
  last_run_at: null,
  last_status: null,
  last_error: null,
  enabled: true,
  state: "scheduled",
  paused_at: null,
  ...over,
});

function fake(handler: (params: Record<string, unknown>) => unknown) {
  const calls: Record<string, unknown>[] = [];
  const client: CronClient = {
    request: async (_method, params = {}) => {
      calls.push(params);
      return (await handler(params)) as Record<string, unknown>;
    },
  };
  return { client, calls };
}

describe("parseJobs", () => {
  it("maps a live row", () => {
    expect(parseJobs([row()])).toEqual([
      {
        id: "487f141b762b",
        name: "hermate-probe-job",
        schedule: "0 0 1 1 *",
        promptPreview: "probe only: say hi",
        nextRunAt: "2027-01-01T00:00:00+11:00",
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        enabled: true,
        state: "scheduled",
        repeat: "forever",
        deliver: "local",
      },
    ]);
  });

  it("reads a paused job, a numeric repeat, and falls back to the fire error", () => {
    const [j] = parseJobs([row({ enabled: false, state: "paused", repeat: 3, last_error: null, last_fire_error: "boom" })]);
    expect(j).toMatchObject({ enabled: false, state: "paused", repeat: "3", lastError: "boom" });
  });

  it("drops entries without an id, sorts by name, and survives junk", () => {
    const out = parseJobs([null, "x", { name: "no id" }, row({ job_id: "b", name: "zeta" }), row({ job_id: "a", name: "alpha" })]);
    expect(out.map((j) => j.id)).toEqual(["a", "b"]);
    expect(parseJobs(undefined)).toEqual([]);
  });
});

describe("validateNewJob", () => {
  const ok = { name: "n", schedule: "every 2h", prompt: "do it" };
  it("accepts a complete job and rejects each missing piece", () => {
    expect(validateNewJob(ok)).toBeNull();
    expect(validateNewJob({ ...ok, name: "  " })).toMatch(/name/);
    expect(validateNewJob({ ...ok, name: "x".repeat(81) })).toMatch(/too long/);
    expect(validateNewJob({ ...ok, schedule: "" })).toMatch(/schedule/i);
    expect(validateNewJob({ ...ok, prompt: " " })).toMatch(/what Hermes should do/i);
  });
  it("repeat must be a positive whole number", () => {
    expect(validateNewJob({ ...ok, repeat: 2 })).toBeNull();
    for (const bad of [0, -1, 1.5, NaN]) expect(validateNewJob({ ...ok, repeat: bad })).toMatch(/Repeat/);
  });
});

describe("CronStore", () => {
  it("lists with include_disabled so paused jobs do not look deleted", async () => {
    const { client, calls } = fake(() => ({ success: true, count: 1, jobs: [row()] }));
    const store = new CronStore(client);
    await store.refresh();
    expect(calls[0]).toEqual({ action: "list", include_disabled: true });
    expect(store.get().jobs).toHaveLength(1);
    expect(store.get()).toMatchObject({ loading: false, error: null });
  });

  it("shows a failed tool result ({success:false}) as an error and keeps the last good list", async () => {
    let fail = false;
    const { client } = fake(() => (fail ? { success: false, error: "scheduler unavailable" } : { success: true, jobs: [row()] }));
    const store = new CronStore(client);
    await store.refresh();
    fail = true;
    await store.refresh();
    expect(store.get().error).toBe("scheduler unavailable");
    expect(store.get().jobs).toHaveLength(1);
  });

  it("shows an RPC failure (for example an older Hermes without cron.manage)", async () => {
    const { client } = fake(() => {
      throw new Error("method not found");
    });
    const store = new CronStore(client);
    await store.refresh();
    expect(store.get()).toMatchObject({ error: "method not found", loading: false, jobs: [] });
  });

  it("adds with trimmed fields and only sends repeat when given, then reloads", async () => {
    const { client, calls } = fake((p) => (p.action === "list" ? { success: true, jobs: [row()] } : { success: true, job_id: "x" }));
    const store = new CronStore(client);
    expect(await store.add({ name: " Daily ", schedule: " every 2h ", prompt: " do it ", repeat: 3 })).toBe(true);
    expect(calls[0]).toEqual({ action: "add", name: "Daily", schedule: "every 2h", prompt: "do it", repeat: 3 });
    expect(calls[1]).toMatchObject({ action: "list" });
    await store.add({ name: "n", schedule: "30m", prompt: "p" });
    expect(calls.find((c, i) => i >= 2 && c.action === "add")).not.toHaveProperty("repeat");
  });

  it("does not send an invalid job, and says why", async () => {
    const { client, calls } = fake(() => ({ success: true, jobs: [] }));
    const store = new CronStore(client);
    expect(await store.add({ name: "", schedule: "30m", prompt: "p" })).toBe(false);
    expect(calls).toHaveLength(0);
    expect(store.get().error).toMatch(/name/);
  });

  it("keeps Hermes' schedule error visible after the reload that follows a refused add", async () => {
    const message = "Invalid schedule 'not a schedule'. Use: …";
    const { client } = fake((p) => (p.action === "add" ? { success: false, error: message } : { success: true, jobs: [] }));
    const store = new CronStore(client);
    expect(await store.add({ name: "bad", schedule: "not a schedule", prompt: "x" })).toBe(false);
    expect(store.get().error).toBe(message);
  });

  it("pause, resume and remove address the job by id and reload", async () => {
    const { client, calls } = fake((p) => (p.action === "list" ? { success: true, jobs: [] } : { success: true }));
    const store = new CronStore(client);
    expect(await store.pause("j1")).toBe(true);
    expect(await store.resume("j1")).toBe(true);
    expect(await store.remove("j1")).toBe(true);
    expect(calls.filter((c) => c.action !== "list")).toEqual([
      { action: "pause", name: "j1" },
      { action: "resume", name: "j1" },
      { action: "remove", name: "j1" },
    ]);
    expect(calls.filter((c) => c.action === "list")).toHaveLength(3);
  });

  it("reports a job that is already gone", async () => {
    const { client } = fake((p) =>
      p.action === "list" ? { success: true, jobs: [] } : { success: false, error: "Job with ID or name 'j1' not found." },
    );
    const store = new CronStore(client);
    expect(await store.remove("j1")).toBe(false);
    expect(store.get().error).toMatch(/not found/);
  });

  it("an older refresh never overwrites a newer one, and nothing updates after dispose", async () => {
    const resolvers: ((v: unknown) => void)[] = [];
    const { client } = fake(() => new Promise((r) => resolvers.push(r)));
    const store = new CronStore(client);
    const first = store.refresh();
    const second = store.refresh();
    resolvers[1]({ success: true, jobs: [row({ job_id: "new", name: "new" })] });
    await second;
    resolvers[0]({ success: true, jobs: [row({ job_id: "stale", name: "stale" })] });
    await first;
    expect(store.get().jobs.map((j) => j.id)).toEqual(["new"]);

    let notified = 0;
    store.subscribe(() => notified++);
    store.dispose();
    const third = store.refresh();
    resolvers[2]({ success: true, jobs: [] });
    await third;
    expect(notified).toBe(0);
  });
});
