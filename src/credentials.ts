import { invoke } from "@tauri-apps/api/core";

/**
 * Secrets (Hermes tokens) live only in Windows Credential Manager, behind the Rust
 * `credential_*` commands. Settings files hold the opaque `credentialId`, never the value.
 * Never log what these return.
 */
export const credentials = {
  save(credentialId: string, secret: string): Promise<void> {
    return invoke<void>("credential_set", { id: credentialId, secret });
  },

  /** `null` when nothing is stored under this id. Keep the value in memory only. */
  async load(credentialId: string): Promise<string | null> {
    return (await invoke<string | null>("credential_get", { id: credentialId })) ?? null;
  },

  remove(credentialId: string): Promise<void> {
    return invoke<void>("credential_delete", { id: credentialId });
  },
};
