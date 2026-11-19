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
  startSshTunnel: async ({ host, user, port, remotePort }) => {
    const { id, port: localPort } = await invoke<{ id: number; port: number }>("ssh_tunnel_start", {
      host,
      user,
      port: port ?? null,
      remotePort,
    });
    return { port: localPort, stop: () => invoke<void>("ssh_tunnel_stop", { id }) };
  },
};

export const stopLocalBackend = (): Promise<void> => invoke<void>("local_backend_stop");
