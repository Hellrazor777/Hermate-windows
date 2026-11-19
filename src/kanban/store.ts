import type { HermesClient } from "../rpc";

export type KanbanClient = Pick<HermesClient, "pluginRequest">;

const API = "/api/plugins/kanban";

export interface KanbanBoardInfo {
  slug: string;
  name: string;
  total: number;
}

export interface KanbanTask {
  id: string;
  title: string;
  body: string;
  assignee: string | null;
  status: string;
  priority: number;
  commentCount: number;
  /** What the worker reported when it finished, if it did. */
  result: string | null;
}

export interface KanbanColumn {
  name: string;
  tasks: KanbanTask[];
}

export interface KanbanComment {
  id: number;
  author: string;
  body: string;
  createdAt: number | null;
}

export interface KanbanDetail {
  task: KanbanTask;
  comments: KanbanComment[];
}

export interface KanbanSnapshot {
  boards: KanbanBoardInfo[];
  /** The board being shown, or null before the first load. */
  board: string | null;
  columns: KanbanColumn[];
  assignees: string[];
  detail: KanbanDetail | null;
  loading: boolean;
  error: string | null;
}

export interface NewTask {
  title: string;
  body?: string;
  assignee?: string;
}

/** The moves Hermate offers. Hermes decides whether one is allowed and says why when it refuses. */
export type TaskMove = "ready" | "blocked" | "done" | "archived";

const EMPTY: KanbanSnapshot = { boards: [], board: null, columns: [], assignees: [], detail: null, loading: false, error: null };

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function parseTask(raw: unknown): KanbanTask | null {
  const o = rec(raw);
  const id = o && str(o.id);
  if (!o || !id) return null;
  return {
    id,
    title: str(o.title) ?? id,
    body: typeof o.body === "string" ? o.body : "",
    assignee: str(o.assignee),
    status: str(o.status) ?? "todo",
    priority: typeof o.priority === "number" ? o.priority : 0,
    commentCount: typeof o.comment_count === "number" ? o.comment_count : 0,
    result: str(o.result),
  };
}

export function parseBoards(raw: unknown): KanbanBoardInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: KanbanBoardInfo[] = [];
  for (const r of raw) {
    const o = rec(r);
    const slug = o && str(o.slug);
    if (!o || !slug || o.archived === true) continue;
    out.push({ slug, name: str(o.name) ?? slug, total: typeof o.total === "number" ? o.total : 0 });
  }
  return out;
}

/** Columns in Hermes' order. Unknown or malformed ones are dropped, never guessed. */
export function parseColumns(raw: unknown): KanbanColumn[] {
  if (!Array.isArray(raw)) return [];
  const out: KanbanColumn[] = [];
  for (const c of raw) {
    const o = rec(c);
    const name = o && str(o.name);
    if (!o || !name) continue;
    const tasks = (Array.isArray(o.tasks) ? o.tasks : []).map(parseTask).filter((t): t is KanbanTask => t !== null);
    out.push({ name, tasks });
  }
  return out;
}

export function parseComments(raw: unknown): KanbanComment[] {
  if (!Array.isArray(raw)) return [];
  const out: KanbanComment[] = [];
  for (const r of raw) {
    const o = rec(r);
    if (!o || typeof o.id !== "number" || typeof o.body !== "string") continue;
    out.push({ id: o.id, author: str(o.author) ?? "unknown", body: o.body, createdAt: typeof o.created_at === "number" ? o.created_at : null });
  }
  return out;
}

export function validateNewTask(t: NewTask): string | null {
  if (!t.title.trim()) return "Give the task a title.";
  if (t.title.trim().length > 200) return "The title is too long (200 characters at most).";
  return null;
}

const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const q = (board: string) => `?board=${encodeURIComponent(board)}`;
const seg = (id: string) => encodeURIComponent(id);

/** The Kanban board(s) on the connected Hermes, through its dashboard plugin API. */
export class KanbanStore {
  private snapshot: KanbanSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private disposed = false;
  private latest = 0;
  private latestDetail = 0;

  constructor(private readonly client: KanbanClient) {}

  get = (): KanbanSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Reload the board list and the shown board. Hermes' current board is the default until one is chosen. */
  async refresh(): Promise<void> {
    const mine = ++this.latest;
    this.set({ loading: true });
    try {
      const boardsRes = await this.client.pluginRequest("GET", `${API}/boards`);
      const boards = parseBoards(boardsRes.boards);
      const wanted = this.snapshot.board;
      const current = str(boardsRes.current);
      const board = boards.find((b) => b.slug === wanted)?.slug ?? boards.find((b) => b.slug === current)?.slug ?? boards[0]?.slug ?? null;
      if (!board) {
        if (mine === this.latest) this.set({ ...EMPTY, loading: false });
        return;
      }
      const res = await this.client.pluginRequest("GET", `${API}/board${q(board)}`);
      if (mine !== this.latest) return;
      const assignees = Array.isArray(res.assignees) ? res.assignees.filter((a): a is string => typeof a === "string") : [];
      this.set({ boards, board, columns: parseColumns(res.columns), assignees, loading: false, error: null });
    } catch (e) {
      if (mine === this.latest) this.set({ loading: false, error: message(e, "Could not load the Kanban board.") });
    }
  }

  async selectBoard(slug: string): Promise<void> {
    if (slug === this.snapshot.board) return;
    this.set({ board: slug, columns: [], detail: null });
    await this.refresh();
  }

  async create(task: NewTask): Promise<boolean> {
    const board = this.snapshot.board;
    const problem = validateNewTask(task);
    if (problem || !board) {
      this.set({ error: problem ?? "No board is open." });
      return false;
    }
    const body: Record<string, unknown> = { title: task.title.trim() };
    if (task.body?.trim()) body.body = task.body.trim();
    if (task.assignee) body.assignee = task.assignee;
    return this.mutate(() => this.client.pluginRequest("POST", `${API}/tasks${q(board)}`, body));
  }

  /** Move a task. Hermes refuses `done` without evidence, so completing needs a result note. */
  async move(id: string, status: TaskMove, result?: string): Promise<boolean> {
    const board = this.snapshot.board;
    if (!board) return false;
    const body: Record<string, unknown> = { status };
    if (status === "done") {
      if (!result?.trim()) {
        this.set({ error: "Write what was done before completing the task." });
        return false;
      }
      body.result = result.trim();
    }
    return this.mutate(() => this.client.pluginRequest("PATCH", `${API}/tasks/${seg(id)}${q(board)}`, body), id);
  }

  async comment(id: string, text: string): Promise<boolean> {
    const board = this.snapshot.board;
    if (!board) return false;
    if (!text.trim()) {
      this.set({ error: "Write a comment first." });
      return false;
    }
    return this.mutate(
      () => this.client.pluginRequest("POST", `${API}/tasks/${seg(id)}/comments${q(board)}`, { body: text.trim(), author: "hermate" }),
      id,
    );
  }

  /** Show one task with its comments. */
  async open(id: string): Promise<void> {
    const board = this.snapshot.board;
    if (!board) return;
    const mine = ++this.latestDetail;
    try {
      const res = await this.client.pluginRequest("GET", `${API}/tasks/${seg(id)}${q(board)}`);
      if (mine !== this.latestDetail || board !== this.snapshot.board) return;
      const task = parseTask(res.task);
      if (!task) throw new Error("Hermes sent an unreadable task.");
      this.set({ detail: { task, comments: parseComments(res.comments) }, error: null });
    } catch (e) {
      if (mine === this.latestDetail) this.set({ error: message(e, "Could not open the task.") });
    }
  }

  close(): void {
    this.latestDetail++;
    this.set({ detail: null });
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  /** Run one change, then reload (Hermes is authoritative); a refusal stays visible after the reload. */
  private async mutate(run: () => Promise<unknown>, reopen?: string): Promise<boolean> {
    let failure: string | null = null;
    try {
      await run();
    } catch (e) {
      failure = message(e, "That change was not applied.");
    }
    await this.refresh();
    if (reopen && this.snapshot.detail?.task.id === reopen) await this.open(reopen);
    if (failure) this.set({ error: failure });
    return failure === null;
  }

  private set(patch: Partial<KanbanSnapshot>): void {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }
}
