import type { HermesClient } from "../rpc";

/** A scheduled job as `cron.manage list` reports it (verified live; see docs/PROTOCOL.md). */
export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  promptPreview: string;
  /** ISO timestamps, as Hermes sends them. */
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  enabled: boolean;
  state: string;
  repeat: string;
  deliver: string;
}

export type CronClient = Pick<HermesClient, "request">;

export interface CronSnapshot {
  jobs: CronJob[];
  loading: boolean;
  error: string | null;
}

export interface NewJob {
  name: string;
  schedule: string;
  prompt: string;
  /** Run this many times, then stop; omit to repeat forever. */
  repeat?: number;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Keep well-formed jobs only, in a stable order (by name). Hermes is authoritative. */
export function parseJobs(raw: unknown): CronJob[] {
  if (!Array.isArray(raw)) return [];
  const jobs: CronJob[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const id = str(o.job_id);
    if (!id) continue;
    const enabled = o.enabled !== false;
    jobs.push({
      id,
      name: str(o.name) ?? id,
      schedule: str(o.schedule) ?? "?",
      promptPreview: typeof o.prompt_preview === "string" ? o.prompt_preview : "",
      nextRunAt: str(o.next_run_at),
      lastRunAt: str(o.last_run_at),
      lastStatus: str(o.last_status),
      lastError: str(o.last_error) ?? str(o.last_fire_error),
      enabled,
      state: str(o.state) ?? (enabled ? "scheduled" : "paused"),
      repeat: o.repeat === undefined || o.repeat === null ? "forever" : String(o.repeat),
      deliver: str(o.deliver) ?? "local",
    });
  }
  return jobs.sort((a, b) => a.name.localeCompare(b.name));
}

/** Why a new job is not acceptable yet, or null. Hermes still validates the schedule itself. */
export function validateNewJob(job: NewJob): string | null {
  if (!job.name.trim()) return "Give the job a name.";
  if (job.name.trim().length > 80) return "The name is too long (80 characters at most).";
  if (!job.schedule.trim()) return "Enter a schedule, for example “every 2h” or “0 9 * * *”.";
  if (!job.prompt.trim()) return "Enter what Hermes should do each time.";
  if (job.repeat !== undefined && (!Number.isInteger(job.repeat) || job.repeat < 1)) return "Repeat must be a whole number, 1 or more.";
  return null;
}

/** Scheduled jobs on the connected Hermes, managed through the `cron.manage` RPC. */
export class CronStore {
  private snapshot: CronSnapshot = { jobs: [], loading: false, error: null };
  private listeners = new Set<() => void>();
  private disposed = false;
  private latest = 0;

  constructor(private readonly client: CronClient) {}

  get = (): CronSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Paused jobs are always requested: Hermes hides them by default, which would read as a deletion. */
  async refresh(): Promise<void> {
    const mine = ++this.latest;
    this.set({ loading: true });
    try {
      const res = await this.client.request("cron.manage", { action: "list", include_disabled: true });
      if (mine !== this.latest) return;
      const failure = toolError(res);
      if (failure) this.set({ loading: false, error: failure });
      else this.set({ jobs: parseJobs(res.jobs), loading: false, error: null });
    } catch (e) {
      if (mine === this.latest) this.set({ loading: false, error: failureText(e, "Could not load scheduled jobs.") });
    }
  }

  async add(job: NewJob): Promise<boolean> {
    const problem = validateNewJob(job);
    if (problem) {
      this.set({ error: problem });
      return false;
    }
    const params: Record<string, unknown> = {
      action: "add",
      name: job.name.trim(),
      schedule: job.schedule.trim(),
      prompt: job.prompt.trim(),
    };
    if (job.repeat !== undefined) params.repeat = job.repeat;
    return this.mutate(params);
  }

  pause = (id: string): Promise<boolean> => this.mutate({ action: "pause", name: id });
  resume = (id: string): Promise<boolean> => this.mutate({ action: "resume", name: id });
  /** Delete a job permanently. */
  remove = (id: string): Promise<boolean> => this.mutate({ action: "remove", name: id });

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  /** Run one change, surface Hermes' reason if it refuses, then reload the list (Hermes is authoritative). */
  private async mutate(params: Record<string, unknown>): Promise<boolean> {
    let failure: string | null = null;
    try {
      failure = toolError(await this.client.request("cron.manage", params));
    } catch (e) {
      failure = failureText(e, "That change was not applied.");
    }
    await this.refresh(); // a successful reload clears `error`, so show the refusal again afterwards
    if (failure) this.set({ error: failure });
    return failure === null;
  }

  private set(patch: Partial<CronSnapshot>): void {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }
}

/** A refusal inside a normal reply: `{success: false, error}` (a failed tool call, not a failed RPC). */
function toolError(res: Record<string, unknown>): string | null {
  if (res.success === false) return typeof res.error === "string" && res.error ? res.error : "Hermes refused the change.";
  return null;
}

const failureText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
