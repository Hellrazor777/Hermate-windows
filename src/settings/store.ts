import { containsSecretKey, DEFAULT_SETTINGS, normalizeSettings, type Settings } from "./schema";

/** The subset of `Storage` the store needs; lets tests inject an in-memory one. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const SETTINGS_KEY = "hermate.settings";

/** Observable, persisted preferences. Storage failures never throw: the in-memory value stays usable. */
export class SettingsStore {
  private current: Settings;
  private listeners = new Set<() => void>();

  constructor(private readonly storage: KeyValueStorage | null) {
    this.current = this.read();
  }

  get = (): Settings => this.current;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Merge a patch, validate, persist, notify. Invalid patch fields are ignored. */
  update(patch: Partial<Omit<Settings, "version">>): void {
    if (containsSecretKey(patch)) throw new Error("Secrets must not be stored in settings.");
    const next = normalizeSettings({ ...this.current, ...patch });
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.current = next; // new object identity so useSyncExternalStore re-renders
    this.write();
    this.listeners.forEach((l) => l());
  }

  reset(): void {
    this.current = { ...DEFAULT_SETTINGS };
    this.write();
    this.listeners.forEach((l) => l());
  }

  private read(): Settings {
    try {
      const text = this.storage?.getItem(SETTINGS_KEY);
      return text ? normalizeSettings(JSON.parse(text)) : { ...DEFAULT_SETTINGS };
    } catch {
      return { ...DEFAULT_SETTINGS }; // corrupt JSON or blocked storage: fall back to defaults
    }
  }

  private write(): void {
    try {
      this.storage?.setItem(SETTINGS_KEY, JSON.stringify(this.current));
    } catch {
      /* storage full or unavailable: keep running in memory */
    }
  }
}

/** The webview's localStorage, or null where it is blocked (private windows, previews, tests). */
export function browserStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
