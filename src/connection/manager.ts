import { HermesClient, type WebSocketLike } from "../rpc";
import type { ConnectionProfile } from "./profile";

/** What the manager needs from the outside world; the real ones are the Tauri bridges. */
export interface ConnectionDeps {
  startLocalBackend(): Promise<{ port: number; token: string }>;
  loadSecret(credentialId: string): Promise<string | null>;
  /** Test seam passed through to the client. */
  webSocketFactory?: (url: string) => WebSocketLike;
}

/** Why a profile cannot be connected; the UI shows `message` verbatim. Never contains a secret. */
export class ConnectionUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: "ssh-unsupported" | "missing-token" | "local-failed",
  ) {
    super(message);
    this.name = "ConnectionUnavailableError";
  }
}

/**
 * Build a connected `HermesClient` for a profile. Fails closed: anything that cannot be set up
 * (SSH, a missing token) is an explicit error, never a silent fallback to another connection.
 */
export async function connectProfile(profile: ConnectionProfile, deps: ConnectionDeps): Promise<HermesClient> {
  const { baseUrl, token } = await resolveEndpoint(profile, deps);
  const client = new HermesClient({ baseUrl, token, webSocketFactory: deps.webSocketFactory });
  try {
    await client.connect();
  } catch (e) {
    client.close(); // stop the background reconnect loop of a client nobody will use
    throw e;
  }
  return client;
}

async function resolveEndpoint(
  profile: ConnectionProfile,
  deps: ConnectionDeps,
): Promise<{ baseUrl: string; token: string }> {
  switch (profile.kind) {
    case "local": {
      try {
        const { port, token } = await deps.startLocalBackend();
        return { baseUrl: `http://127.0.0.1:${port}`, token };
      } catch (e) {
        throw new ConnectionUnavailableError(typeof e === "string" ? e : "Could not start the local Hermes backend.", "local-failed");
      }
    }
    case "remote": {
      const token = await deps.loadSecret(profile.credentialId);
      if (!token) {
        throw new ConnectionUnavailableError(
          "No token is stored for this connection. Edit it and enter the Hermes token.",
          "missing-token",
        );
      }
      return { baseUrl: profile.url, token };
    }
    case "ssh":
      throw new ConnectionUnavailableError(
        "SSH-forwarded connections are not available yet. Use a local or remote (https) connection.",
        "ssh-unsupported",
      );
  }
}
