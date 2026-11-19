import { useRef, useState } from "react";
import { credentials } from "../credentials";
import type { HermesClient } from "../rpc";
import { useSettings } from "../settings";
import { connectProfile } from "./manager";
import { nativeDeps } from "./native";
import { LOCAL_PROFILE, normalizeProfile, validateRemoteUrl, type ConnectionProfile } from "./profile";

type Status = { state: "idle" } | { state: "connecting"; id: string } | { state: "connected"; id: string } | { state: "error"; message: string };

const describe = (p: ConnectionProfile) =>
  p.kind === "local" ? "Runs Hermes on this computer" : p.kind === "remote" ? p.url : `${p.user}@${p.host} (over SSH)`;

const parsePort = (text: string): number | undefined | "bad" => {
  if (!text.trim()) return undefined;
  const n = Number(text);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : "bad";
};

export default function ConnectionScreen({ onConnected }: { onConnected?: (client: HermesClient | null) => void }) {
  const [settings, update] = useSettings();
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [sshName, setSshName] = useState("");
  const [sshHost, setSshHost] = useState("");
  const [sshUser, setSshUser] = useState("");
  const [sshPort, setSshPort] = useState("");
  const [sshRemotePort, setSshRemotePort] = useState("");
  const [sshToken, setSshToken] = useState("");
  const [sshError, setSshError] = useState<string | null>(null);
  const client = useRef<HermesClient | null>(null);

  const profiles = [LOCAL_PROFILE, ...settings.connections];

  async function connect(profile: ConnectionProfile) {
    client.current?.close();
    client.current = null;
    setStatus({ state: "connecting", id: profile.id });
    try {
      client.current = await connectProfile(profile, nativeDeps);
      setStatus({ state: "connected", id: profile.id });
      update({ activeConnectionId: profile.kind === "local" ? null : profile.id });
      onConnected?.(client.current);
    } catch (e) {
      setStatus({ state: "error", message: e instanceof Error ? e.message : "Could not connect." });
    }
  }

  function disconnect() {
    client.current?.close();
    client.current = null;
    setStatus({ state: "idle" });
    onConnected?.(null);
  }

  async function addRemote(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const checked = validateRemoteUrl(url);
    if (!checked.ok) return setFormError(checked.error);
    if (!name.trim()) return setFormError("Give the connection a name.");
    if (!token.trim()) return setFormError("Enter the Hermes token.");
    const id = `remote-${crypto.randomUUID()}`;
    const credentialId = `cred-${id}`;
    try {
      await credentials.save(credentialId, token.trim());
    } catch (err) {
      return setFormError(typeof err === "string" ? err : "Could not store the token in Windows Credential Manager.");
    }
    update({ connections: [...settings.connections, { id, name: name.trim(), kind: "remote", url: checked.url, credentialId }] });
    setName("");
    setUrl("");
    setToken(""); // the token now lives only in Credential Manager
  }

  async function addSsh(e: React.FormEvent) {
    e.preventDefault();
    setSshError(null);
    const port = parsePort(sshPort);
    const remotePort = parsePort(sshRemotePort);
    if (!sshName.trim()) return setSshError("Give the connection a name.");
    if (port === "bad" || remotePort === "bad") return setSshError("Ports must be numbers from 1 to 65535.");
    if (!sshToken.trim()) return setSshError("Enter the Hermes token.");
    const id = `ssh-${crypto.randomUUID()}`;
    const credentialId = `cred-${id}`;
    const profile = normalizeProfile({
      id, name: sshName, kind: "ssh", host: sshHost.trim(), user: sshUser.trim(), port, remotePort, credentialId,
    });
    if (!profile) return setSshError("Check the host and user: letters, digits, dots and dashes only.");
    try {
      await credentials.save(credentialId, sshToken.trim());
    } catch (err) {
      return setSshError(typeof err === "string" ? err : "Could not store the token in Windows Credential Manager.");
    }
    update({ connections: [...settings.connections, profile] });
    setSshName("");
    setSshHost("");
    setSshUser("");
    setSshPort("");
    setSshRemotePort("");
    setSshToken(""); // the token now lives only in Credential Manager
  }

  async function remove(p: ConnectionProfile) {
    if ((p.kind === "remote" || p.kind === "ssh") && p.credentialId) await credentials.remove(p.credentialId).catch(() => undefined);
    update({
      connections: settings.connections.filter((c) => c.id !== p.id),
      activeConnectionId: settings.activeConnectionId === p.id ? null : settings.activeConnectionId,
    });
    if (status.state === "connected" && status.id === p.id) disconnect();
  }

  return (
    <section>
      <h2>Connection</h2>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {profiles.map((p) => {
          const connected = status.state === "connected" && status.id === p.id;
          const busy = status.state === "connecting" && status.id === p.id;
          return (
            <li key={p.id} style={{ margin: "8px 0" }}>
              <strong>{p.name}</strong> <span className="muted">{describe(p)}</span>{" "}
              {connected ? (
                <button onClick={disconnect}>Disconnect</button>
              ) : (
                <button disabled={busy} onClick={() => connect(p)}>
                  {busy ? "Connecting…" : "Connect"}
                </button>
              )}{" "}
              {p.id !== LOCAL_PROFILE.id && <button onClick={() => remove(p)}>Remove</button>}
              {connected && <span> ✓ connected</span>}
            </li>
          );
        })}
      </ul>
      {status.state === "error" && <p role="alert">{status.message}</p>}

      <form onSubmit={addRemote}>
        <fieldset>
          <legend>Add a remote Hermes (https)</legend>
          <label>
            Name <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            URL <input value={url} placeholder="https://hermes.example.com" onChange={(e) => setUrl(e.target.value)} />
          </label>
          <label>
            Token{" "}
            <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
          </label>
          <p className="muted">The token is stored in Windows Credential Manager, not in settings.</p>
          {formError && <p role="alert">{formError}</p>}
          <button type="submit">Save connection</button>
        </fieldset>
      </form>

      <form onSubmit={addSsh}>
        <fieldset>
          <legend>Add a Hermes over SSH</legend>
          <label>
            Name <input aria-label="SSH name" value={sshName} onChange={(e) => setSshName(e.target.value)} />
          </label>
          <label>
            Host <input aria-label="SSH host" value={sshHost} placeholder="box.example.com" onChange={(e) => setSshHost(e.target.value)} />
          </label>
          <label>
            User <input aria-label="SSH user" value={sshUser} onChange={(e) => setSshUser(e.target.value)} />
          </label>
          <label>
            SSH port <input aria-label="SSH port" value={sshPort} placeholder="22" onChange={(e) => setSshPort(e.target.value)} />
          </label>
          <label>
            Hermes port on the host{" "}
            <input aria-label="Hermes port" value={sshRemotePort} placeholder="9119" onChange={(e) => setSshRemotePort(e.target.value)} />
          </label>
          <label>
            Hermes token{" "}
            <input aria-label="SSH token" type="password" autoComplete="off" value={sshToken} onChange={(e) => setSshToken(e.target.value)} />
          </label>
          <p className="muted">
            Uses your Windows OpenSSH client with keys or ssh-agent (no password prompts). Connect to the host once in a
            terminal first so its host key is trusted. The token is stored in Windows Credential Manager.
          </p>
          {sshError && <p role="alert">{sshError}</p>}
          <button type="submit">Save SSH connection</button>
        </fieldset>
      </form>
    </section>
  );
}
