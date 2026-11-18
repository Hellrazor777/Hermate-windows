import { useSyncExternalStore } from "react";
import { browserStorage, SettingsStore } from "./store";
import type { Settings } from "./schema";

export * from "./schema";
export * from "./store";
export * from "./theme";

/** The app-wide store, backed by the webview's localStorage. */
export const settingsStore = new SettingsStore(browserStorage());

export function useSettings(): [Settings, SettingsStore["update"]] {
  const settings = useSyncExternalStore(settingsStore.subscribe, settingsStore.get);
  return [settings, (patch) => settingsStore.update(patch)];
}
