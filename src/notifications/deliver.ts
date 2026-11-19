import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import type { Notice } from "./notifier";

/** The three calls delivery needs; tests pass a fake. */
export interface NotificationApi {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<"granted" | "denied" | "default">;
  send(notice: Notice): void;
}

const tauriApi: NotificationApi = {
  isPermissionGranted,
  requestPermission,
  send: (n) => sendNotification({ title: n.title, body: n.body }),
};

/**
 * Show desktop notifications. Permission is asked for once, the first time something needs showing, and a refusal is
 * remembered for the session (no nagging). Any failure is swallowed: a missed notification must never break the app,
 * and nothing about the notice is logged.
 */
export function createDeliverer(api: NotificationApi = tauriApi): (notices: Notice[]) => Promise<void> {
  let permission: "unknown" | "granted" | "denied" = "unknown";
  return async (notices) => {
    if (notices.length === 0 || permission === "denied") return;
    try {
      if (permission === "unknown") {
        const granted = (await api.isPermissionGranted()) || (await api.requestPermission()) === "granted";
        permission = granted ? "granted" : "denied";
      }
      if (permission === "granted") for (const n of notices) api.send(n);
    } catch {
      // Leave permission as it was: a transient failure may work next time.
    }
  };
}
