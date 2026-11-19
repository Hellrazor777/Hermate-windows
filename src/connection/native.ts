import { invoke } from "@tauri-apps/api/core";
import { credentials } from "../credentials";
import { tauriWebSocketFactory } from "../rpc/tauriSocket";
import type { ConnectionDeps } from "./manager";

/**
 * The real bridges to the Rust side. The WebSocket must be opened natively: Hermes' Origin gate
 * answers 403 to the webview's origin, so a browser-side WebSocket can never connect.
 */
export const nativeDeps: ConnectionDeps = {
  startLocalBackend: () => invoke<{ port: number; token: string }>("local_backend_start"),
  loadSecret: (id) => credentials.load(id),
  webSocketFactory: tauriWebSocketFactory,
};

export const stopLocalBackend = (): Promise<void> => invoke<void>("local_backend_stop");
