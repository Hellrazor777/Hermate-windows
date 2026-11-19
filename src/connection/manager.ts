import { HermesClient, type WebSocketLike } from "../rpc";
import { DEFAULT_REMOTE_PORT, type ConnectionProfile } from "./profile";

/** What the manager needs from the outside world; the real ones are the Tauri bridges. */
export interface ConnectionDeps {
  startLocalBackend(): Promise<{ port: number; token: string }>;
  loadSecret(credentialId: string): Promise<string | null>;
  /** Forward a loopback port to Hermes on the SSH host. Rejects with a displayable message. */
  startSshTunnel(target: { host: string; user: string; port?: number; remotePort: number }): Promise<SshTunnel>;
  /** Test seam passed through to the client. */
  webSocketFactory?: (url: string) => WebSocketLike;
}

export interface SshTunnel {
  /** Loopback port that reaches Hermes on the remote host. */
  port: number;
  stop(): Promise<void>;
}

/** Why a profile cannot be connected; the UI shows `message` verbatim. Never contains a secret. */
export class ConnectionUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: "ssh-failed" | "missing-token" | "local-failed",
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
  const { baseUrl, token, tunnel } = await resolveEndpoint(profile, deps);
  const client = new HermesClient({ baseUrl, token, webSocketFactory: deps.webSocketFactory });
  if (tunnel) {
    // The SSH forward lives exactly as long as the client: closing the client ends the ssh process.
    const closeClient = client.close.bind(client);
    client.close = () => {
      closeClient();
      void tunnel.stop().catch(() => undefined);
    };
  }
  try {
    await client.connect();
  } catch (e) {
    client.close(); // stop the background reconnect loop (and any tunnel) of a client nobody will use
    throw e;
  }
  return client;
}

async function resolveEndpoint(
  profile: ConnectionProfile,
  deps: ConnectionDeps,
): Promise<{ baseUrl: string; token: string; tunnel?: SshTunnel }> {
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
    case "ssh": {
      const token = profile.credentialId ? await deps.loadSecret(profile.credentialId) : null;
      if (!token) {
        throw new ConnectionUnavailableError(
          "No token is stored for this connection. Remove it and add it again with the Hermes token.",
          "missing-token",
        );
      }
      let tunnel: SshTunnel;
      try {
        tunnel = await deps.startSshTunnel({
          host: profile.host,
          user: profile.user,
          port: profile.port,
          remotePort: profile.remotePort ?? DEFAULT_REMOTE_PORT,
        });
      } catch (e) {
        throw new ConnectionUnavailableError(typeof e === "string" ? e : "Could not open the SSH connection.", "ssh-failed");
      }
      return { baseUrl: `http://127.0.0.1:${tunnel.port}`, token, tunnel };
    }
  }
}
