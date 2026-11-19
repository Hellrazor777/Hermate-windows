import type { HermesClient } from "../rpc";

export type FilesClient = Pick<HermesClient, "pluginRequest">;

/** Largest text file previewed, and largest image. Hermes' own cap is larger; this keeps the window light. */
export const MAX_TEXT_BYTES = 256 * 1024;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** Raster images only: an SVG can carry script. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number | null;
  mime: string | null;
  /** Epoch seconds. */
  mtime: number | null;
}

export type Preview =
  | { kind: "text"; name: string; path: string; size: number; text: string }
  | { kind: "image"; name: string; path: string; size: number; dataUrl: string }
  /** Not shown, with the reason ("too large", "binary", ...). */
  | { kind: "none"; name: string; path: string; size: number | null; reason: string };

export interface FilesSnapshot {
  /** The folder shown, as Hermes reports it; null before the first load. */
  path: string | null;
  parent: string | null;
  entries: FileEntry[];
  preview: Preview | null;
  loading: boolean;
  error: string | null;
}

const EMPTY: FilesSnapshot = { path: null, parent: null, entries: [], preview: null, loading: false, error: null };

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Hermes' own order is kept (folders first, then by name). Malformed rows are dropped. */
export function parseEntries(raw: unknown): FileEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: FileEntry[] = [];
  for (const r of raw) {
    const o = rec(r);
    const name = o && str(o.name);
    const path = o && str(o.path);
    if (!o || !name || !path) continue;
    out.push({
      name,
      path,
      isDirectory: o.is_directory === true,
      size: typeof o.size === "number" ? o.size : null,
      mime: str(o.mime_type),
      mtime: typeof o.mtime === "number" ? o.mtime : null,
    });
  }
  return out;
}

/** `data:<mime>;base64,<payload>` -> its mime type and bytes, or null if it is not that shape. */
export function decodeDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]*);base64,([A-Za-z0-9+/=\s]*)$/.exec(dataUrl);
  if (!m) return null;
  try {
    const bin = atob(m[2].replace(/\s/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { mime: m[1], bytes };
  } catch {
    return null;
  }
}

/** UTF-8 text, or null when the bytes are not text (a NUL byte, or invalid UTF-8). */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const enc = encodeURIComponent;

/**
 * Read-only browsing of the connected Hermes machine's files, through Hermes' `/api/files`.
 * Hermes decides what is visible; the app lists folders and previews a file only when asked to.
 * File contents are never logged or kept beyond the open preview.
 */
export class FilesStore {
  private snapshot: FilesSnapshot = EMPTY;
  private listeners = new Set<() => void>();
  private disposed = false;
  private latest = 0;

  constructor(private readonly client: FilesClient) {}

  get = (): FilesSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** List a folder; with no path, the one Hermes starts in. */
  async list(path?: string): Promise<void> {
    const mine = ++this.latest;
    this.set({ loading: true, error: null });
    try {
      const res = await this.client.pluginRequest("GET", path ? `/api/files?path=${enc(path)}` : "/api/files");
      if (mine !== this.latest) return;
      const shown = str(res.path);
      if (!shown) throw new Error("Hermes sent an unreadable folder.");
      this.set({ path: shown, parent: str(res.parent), entries: parseEntries(res.entries), preview: null, loading: false });
    } catch (e) {
      // Stay on the folder already shown; only say what went wrong.
      if (mine === this.latest) this.set({ loading: false, error: message(e, "Could not open that folder.") });
    }
  }

  refresh = (): Promise<void> => this.list(this.snapshot.path ?? undefined);

  up(): Promise<void> {
    const parent = this.snapshot.parent;
    return parent ? this.list(parent) : Promise.resolve();
  }

  /** A folder opens; a file is previewed (text and small images only). */
  async open(entry: FileEntry): Promise<void> {
    if (entry.isDirectory) return this.list(entry.path);
    // Do not download what would only be refused: the list already says how big a file is and what type.
    const limit = entry.mime && IMAGE_TYPES.has(entry.mime) ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
    if (entry.size !== null && entry.size > limit) {
      this.set({ preview: { kind: "none", name: entry.name, path: entry.path, size: entry.size, reason: "This file is too large to preview." }, error: null });
      return;
    }
    const mine = ++this.latest;
    this.set({ loading: true, error: null });
    try {
      const res = await this.client.pluginRequest("GET", `/api/files/read?path=${enc(entry.path)}`);
      if (mine !== this.latest) return;
      this.set({ preview: toPreview(entry, res), loading: false });
    } catch (e) {
      if (mine === this.latest) this.set({ loading: false, error: message(e, "Could not read that file.") });
    }
  }

  closePreview(): void {
    this.set({ preview: null });
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private set(patch: Partial<FilesSnapshot>): void {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }
}

function toPreview(entry: FileEntry, res: Record<string, unknown>): Preview {
  const base = { name: entry.name, path: entry.path };
  const none = (reason: string, size: number | null = entry.size): Preview => ({ kind: "none", ...base, size, reason });
  const size = typeof res.size === "number" ? res.size : (entry.size ?? 0);
  const decoded = typeof res.data_url === "string" ? decodeDataUrl(res.data_url) : null;
  if (!decoded) return none("Hermes sent an unreadable file.");
  if (IMAGE_TYPES.has(decoded.mime)) {
    if (decoded.bytes.length > MAX_IMAGE_BYTES) return none("This image is too large to preview.", size);
    return { kind: "image", ...base, size, dataUrl: res.data_url as string };
  }
  if (decoded.bytes.length > MAX_TEXT_BYTES) return none("This file is too large to preview.", size);
  const text = decodeText(decoded.bytes);
  return text === null ? none("This looks like a binary file, so it is not shown.", size) : { kind: "text", ...base, size, text };
}
