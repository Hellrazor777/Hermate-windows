import { invoke } from "@tauri-apps/api/core";
import { credentials } from "../credentials";
import type { ConnectionDeps } from "./manager";

/** The real bridges to the Rust side. */
export const nativeDeps: ConnectionDeps = {
  startLocalBackend: () => invoke<{ port: number; token: string }>("local_backend_start"),
  loadSecret: (id) => credentials.load(id),
};

export const stopLocalBackend = (): Promise<void> => invoke<void>("local_backend_stop");
