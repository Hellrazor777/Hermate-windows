import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ActivitySnapshot } from "./useActivity";

/** Event names shared by the main window and the edge widget. */
export const EVENTS = {
  activity: "hermate:activity",
  quickSend: "hermate:quick-send",
  widgetReady: "hermate:widget-ready",
} as const;

/** All of these quietly do nothing outside Tauri (a plain browser, tests). */
export async function setTrayState(snapshot: ActivitySnapshot): Promise<void> {
  try {
    await invoke("set_tray_state", { state: snapshot.state });
  } catch {
    /* no tray available */
  }
}

export async function broadcastActivity(snapshot: ActivitySnapshot): Promise<void> {
  try {
    await emit(EVENTS.activity, snapshot);
  } catch {
    /* no other window listening */
  }
}

export async function setWidgetVisible(visible: boolean): Promise<void> {
  try {
    await invoke("set_widget_visible", { visible });
  } catch {
    /* no widget window */
  }
}

export const showMainWindow = (): Promise<void> => invoke<void>("show_main_window").catch(() => undefined);

export function onEvent<T>(name: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(name, (e) => handler(e.payload));
}

/** Tell the main window the widget just loaded, so it re-sends the current state. */
export const announceWidgetReady = (): Promise<void> => emit(EVENTS.widgetReady).catch(() => undefined);

/** Ask the main window to send a prompt on the widget's behalf. */
export const sendQuickMessage = (text: string): Promise<void> => emit(EVENTS.quickSend, { text });
