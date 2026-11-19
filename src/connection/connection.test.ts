import { describe, expect, it, vi } from "vitest";
import type { WebSocketLike } from "../rpc";
import { ConnectionUnavailableError, connectProfile, type ConnectionDeps } from "./manager";
import { normalizeProfile, validateRemoteUrl } from "./profile";
import { normalizeSettings } from "../settings/schema";

describe("validateRemoteUrl", () => {
  it("accepts https and normalises", () => {
    expect(validateRemoteUrl(" https://Hermes.example.com/ ")).toEqual({ ok: true, url: "https://hermes.example.com" });
    expect(validateRemoteUrl("https://h.example.com:8443/base/")).toEqual({ ok: true, url: "https://h.example.com:8443/base" });
  });
  it("allows plain http only for loopback", () => {
    expect(validateRemoteUrl("http://127.0.0.1:9119")).toEqual({ ok: true, url: "http://127.0.0.1:9119" });
    expect(validateRemoteUrl("http://localhost:9119").ok).toBe(true);
    expect(validateRemoteUrl("http://hermes.example.com").ok).toBe(false);
    expect(validateRemoteUrl("http://127.0.0.1.evil.com").ok).toBe(false);
  });
  it("rejects credentials, query, fragment, junk and other schemes", () => {
    for (const bad of ["https://u:p@h.com", "https://h.com/?token=abc", "https://h.com/#x", "nope", "ftp://h.com", "ws://h.com"]) {
      expect(validateRemoteUrl(bad).ok).toBe(false);
    }
  });
});

describe("normalizeProfile (ssh token)", () => {
  it("keeps a valid credentialId and rejects a malformed one", () => {
    const base = { id: "s", name: "B", kind: "ssh", host: "box.lan", user: "chris" };
    expect(normalizeProfile({ ...base, credentialId: "cred-s" })).toMatchObject({ credentialId: "cred-s" });
    expect(normalizeProfile({ ...base, credentialId: "bad id!" })).toBeNull();
    expect(normalizeProfile({ ...base, credentialId: 5 })).toBeNull();
  });
});

describe("normalizeProfile", () => {
  it("accepts each kind and drops unknown fields", () => {
    expect(normalizeProfile({ id: "local", name: "Me", kind: "local", extra: 1 })).toEqual({ id: "local", name: "Me", kind: "local" });
    expect(normalizeProfile({ id: "r1", name: "Work", kind: "remote", url: "https://h.com/", credentialId: "cred-r1" })).toEqual({
      id: "r1", name: "Work", kind: "remote", url: "https://h.com", credentialId: "cred-r1",
    });
    expect(normalizeProfile({ id: "s1", name: "Box", kind: "ssh", host: "box.lan", user: "chris", port: 22 })).toEqual({
      id: "s1", name: "Box", kind: "ssh", host: "box.lan", user: "chris", port: 22,
    });
  });
  it("rejects invalid profiles", () => {
    const bad = [
      null, [], { id: "x", kind: "local" }, // no name
      { id: "bad id", name: "n", kind: "local" },
      { id: "r", name: "n", kind: "remote", url: "http://h.com", credentialId: "c" },
      { id: "r", name: "n", kind: "remote", url: "https://h.com", credentialId: "bad id" },
      { id: "s", name: "n", kind: "ssh", host: "-oProxyCommand=x", user: "u" },
      { id: "s", name: "n", kind: "ssh", host: "h", user: "-oFoo" },
      { id: "s", name: "n", kind: "ssh", host: "h", user: "u", port: 70000 },
      { id: "q", name: "n", kind: "other" },
    ];
    for (const b of bad) expect(normalizeProfile(b)).toBeNull();
  });
  it("never stores a token field on a remote profile", () => {
    const p = normalizeProfile({ id: "r", name: "n", kind: "remote", url: "https://h.com", credentialId: "c", token: "secret" });
    expect(JSON.stringify(p)).not.toContain("secret");
  });
});

describe("settings connections", () => {
  it("keeps valid profiles, drops invalid and duplicate ones, and fixes a dangling active id", () => {
    const s = normalizeSettings({
      connections: [
        { id: "a", name: "A", kind: "local" },
        { id: "a", name: "dup", kind: "local" },
        { id: "bad", name: "", kind: "local" },
      ],
      activeConnectionId: "gone",
    });
    expect(s.connections.map((c) => c.id)).toEqual(["a"]);
    expect(s.activeConnectionId).toBeNull();
    expect(normalizeSettings({ connections: [{ id: "a", name: "A", kind: "local" }], activeConnectionId: "a" }).activeConnectionId).toBe("a");
  });
});

/** A socket that answers every request with `{}` once opened. */
function autoSocket(urls: string[]): (url: string) => WebSocketLike {
  return (url) => {
    urls.push(url);
    const s: WebSocketLike = {
      onopen: null, onmessage: null, onclose: null, onerror: null,
      send(data) {
        const msg = JSON.parse(data);
        queueMicrotask(() => s.onmessage?.({ data: JSON.stringify({ id: msg.id, result: {} }) }));
      },
      close() {},
    };
    queueMicrotask(() => s.onopen?.({}));
    return s;
  };
}

function deps(over: Partial<ConnectionDeps> = {}, urls: string[] = []): ConnectionDeps {
  return {
    startLocalBackend: async () => ({ port: 4242, token: "local-token" }),
    loadSecret: async () => "remote-token",
    startSshTunnel: async () => ({ port: 5555, stop: async () => undefined }),
    webSocketFactory: autoSocket(urls),
    ...over,
  };
}

describe("connectProfile", () => {
  it("connects to a local backend on the reported port with its token", async () => {
    const urls: string[] = [];
    const client = await connectProfile({ id: "local", name: "Me", kind: "local" }, deps({}, urls));
    expect(urls).toEqual(["ws://127.0.0.1:4242/api/ws?token=local-token"]);
    expect(client.connectionStatus).toBe("connected");
    client.close();
  });

  it("connects to a remote over wss with the stored token", async () => {
    const urls: string[] = [];
    const loadSecret = vi.fn(async () => "remote-token");
    const client = await connectProfile(
      { id: "r", name: "W", kind: "remote", url: "https://h.example.com", credentialId: "cred-r" },
      deps({ loadSecret }, urls),
    );
    expect(loadSecret).toHaveBeenCalledWith("cred-r");
    expect(urls).toEqual(["wss://h.example.com/api/ws?token=remote-token"]);
    client.close();
  });

  it("fails closed when the remote token is missing", async () => {
    await expect(
      connectProfile({ id: "r", name: "W", kind: "remote", url: "https://h.com", credentialId: "c" }, deps({ loadSecret: async () => null })),
    ).rejects.toMatchObject({ name: "ConnectionUnavailableError", reason: "missing-token" });
  });

  const ssh = { id: "s", name: "B", kind: "ssh", host: "box.lan", user: "chris", credentialId: "cred-s" } as const;

  it("connects over an SSH forward on the loopback port, with the stored token", async () => {
    const urls: string[] = [];
    const startSshTunnel = vi.fn(async () => ({ port: 5555, stop: async () => undefined }));
    const client = await connectProfile({ ...ssh, port: 2222, remotePort: 9200 }, deps({ startSshTunnel }, urls));
    expect(startSshTunnel).toHaveBeenCalledWith({ host: "box.lan", user: "chris", port: 2222, remotePort: 9200 });
    expect(urls).toEqual(["ws://127.0.0.1:5555/api/ws?token=remote-token"]);
    client.close();
  });

  it("uses Hermes' default port when the profile names none", async () => {
    const startSshTunnel = vi.fn(async () => ({ port: 5555, stop: async () => undefined }));
    (await connectProfile(ssh, deps({ startSshTunnel }))).close();
    expect(startSshTunnel).toHaveBeenCalledWith(expect.objectContaining({ remotePort: 9119 }));
  });

  it("ends the SSH forward when the client closes", async () => {
    const stop = vi.fn(async () => undefined);
    const client = await connectProfile(ssh, deps({ startSshTunnel: async () => ({ port: 5555, stop }) }));
    expect(stop).not.toHaveBeenCalled();
    client.close();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("ends the SSH forward when the Hermes connection fails", async () => {
    const stop = vi.fn(async () => undefined);
    const failing = () => {
      const s: WebSocketLike = { onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() {} };
      queueMicrotask(() => s.onclose?.({}));
      return s;
    };
    await expect(
      connectProfile(ssh, deps({ startSshTunnel: async () => ({ port: 5555, stop }), webSocketFactory: failing })),
    ).rejects.toBeDefined();
    expect(stop).toHaveBeenCalled();
  });

  it("fails closed without a stored token, before opening any tunnel", async () => {
    const startSshTunnel = vi.fn(async () => ({ port: 1, stop: async () => undefined }));
    for (const profile of [{ ...ssh, credentialId: undefined }, ssh]) {
      const err = await connectProfile(profile, deps({ loadSecret: async () => null, startSshTunnel })).catch((e) => e);
      expect(err).toBeInstanceOf(ConnectionUnavailableError);
      expect(err.reason).toBe("missing-token");
    }
    expect(startSshTunnel).not.toHaveBeenCalled();
  });

  it("shows why SSH failed", async () => {
    const err = await connectProfile(
      ssh,
      deps({ startSshTunnel: async () => { throw "ssh: Permission denied (publickey)."; } }),
    ).catch((e) => e);
    expect(err.reason).toBe("ssh-failed");
    expect(err.message).toContain("Permission denied");
  });

  it("surfaces a local start failure without a secret", async () => {
    const err = await connectProfile(
      { id: "local", name: "Me", kind: "local" },
      deps({ startLocalBackend: async () => { throw "Hermes was not found. Install it, or add it to PATH."; } }),
    ).catch((e) => e);
    expect(err.reason).toBe("local-failed");
    expect(err.message).toContain("not found");
  });
});
