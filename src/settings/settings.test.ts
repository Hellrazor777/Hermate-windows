import { describe, expect, it, vi } from "vitest";
import { containsSecretKey, DEFAULT_SETTINGS, normalizeSettings } from "./schema";
import { SETTINGS_KEY, SettingsStore, type KeyValueStorage } from "./store";
import { applyTheme, resolveTheme, watchTheme } from "./theme";

function memoryStorage(initial?: string): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(SETTINGS_KEY, initial);
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe("normalizeSettings", () => {
  it("defaults everything for junk input", () => {
    for (const raw of [null, undefined, 5, "x", [], {}]) expect(normalizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });
  it("keeps valid fields, replaces invalid ones individually, drops unknown keys", () => {
    expect(normalizeSettings({ theme: "dark", notifications: "yes", edgeWidget: false, extra: 1 })).toEqual({
      version: 1,
      theme: "dark",
      notifications: true,
      edgeWidget: false,
    });
    expect(normalizeSettings({ theme: "neon" }).theme).toBe("system");
  });
});

describe("containsSecretKey", () => {
  it("flags secret-looking keys at any depth but allows credentialId", () => {
    expect(containsSecretKey({ token: "x" })).toBe(true);
    expect(containsSecretKey({ a: [{ apiKey: "x" }] })).toBe(true);
    expect(containsSecretKey({ Password: "x" })).toBe(true);
    expect(containsSecretKey({ credentialId: "conn-1", theme: "dark" })).toBe(false);
  });
});

describe("SettingsStore", () => {
  it("loads defaults, persists updates and notifies", () => {
    const storage = memoryStorage();
    const store = new SettingsStore(storage);
    const listener = vi.fn();
    store.subscribe(listener);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);

    const before = store.get();
    store.update({ theme: "dark" });
    expect(store.get()).not.toBe(before); // new identity for useSyncExternalStore
    expect(listener).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.data.get(SETTINGS_KEY) as string).theme).toBe("dark");
    expect(new SettingsStore(storage).get().theme).toBe("dark"); // survives a restart
  });

  it("does nothing for a no-op update", () => {
    const store = new SettingsStore(memoryStorage());
    const listener = vi.fn();
    store.subscribe(listener);
    store.update({ theme: "system" });
    expect(listener).not.toHaveBeenCalled();
  });

  it("falls back to defaults on corrupt JSON and survives broken storage", () => {
    expect(new SettingsStore(memoryStorage("{not json")).get()).toEqual(DEFAULT_SETTINGS);
    const throwing: KeyValueStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    const store = new SettingsStore(throwing);
    expect(() => store.update({ edgeWidget: false })).not.toThrow();
    expect(store.get().edgeWidget).toBe(false); // still works in memory
    expect(() => new SettingsStore(null).update({ theme: "light" })).not.toThrow();
  });

  it("refuses secrets and ignores invalid patch values", () => {
    const storage = memoryStorage();
    const store = new SettingsStore(storage);
    expect(() => store.update({ token: "abc" } as never)).toThrow(/Secrets/);
    expect(storage.data.has(SETTINGS_KEY)).toBe(false);
    store.update({ theme: "neon" as never });
    expect(store.get().theme).toBe("system");
  });

  it("resets to defaults", () => {
    const store = new SettingsStore(memoryStorage());
    store.update({ theme: "dark", notifications: false });
    store.reset();
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });
});

describe("theme", () => {
  it("resolves system against the OS setting", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("applies data-theme and color-scheme", () => {
    const root = { dataset: {} as Record<string, string | undefined>, style: { colorScheme: "" } };
    applyTheme(root, "dark");
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });

  it("follows OS changes while on system, and stops cleanly", () => {
    const root = { dataset: {} as Record<string, string | undefined>, style: { colorScheme: "" } };
    let listener: (() => void) | undefined;
    const media = {
      matches: false,
      addEventListener: (_: string, l: () => void) => (listener = l),
      removeEventListener: vi.fn(),
    };
    const w = watchTheme(() => "system", root, media as never);
    expect(root.dataset.theme).toBe("light");
    media.matches = true;
    listener?.();
    expect(root.dataset.theme).toBe("dark");
    w.stop();
    expect(media.removeEventListener).toHaveBeenCalled();
  });
});
