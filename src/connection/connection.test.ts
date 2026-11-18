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

  it("reports SSH as unavailable instead of guessing", async () => {
    const err = await connectProfile({ id: "s", name: "B", kind: "ssh", host: "h", user: "u" }, deps()).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectionUnavailableError);
    expect(err.reason).toBe("ssh-unsupported");
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
