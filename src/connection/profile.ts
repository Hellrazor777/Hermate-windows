/**
 * Connection profiles are preferences: they hold where to connect, never a secret. A remote
 * profile points at its token in Windows Credential Manager through `credentialId`.
 */
export type ConnectionProfile =
  | { id: string; name: string; kind: "local" }
  | { id: string; name: string; kind: "remote"; url: string; credentialId: string }
  | { id: string; name: string; kind: "ssh"; host: string; user: string; port?: number; remotePort?: number };

export type ConnectionKind = ConnectionProfile["kind"];

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const SSH_USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

const isLoopbackHost = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");

export type UrlResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * Remote Hermes must use HTTPS (WSS). Plain http is accepted only for loopback, e.g. an
 * SSH-forwarded port. Credentials, query strings and fragments in the URL are rejected so a
 * token can never ride along in a saved URL. Returns the normalised origin + path.
 */
export function validateRemoteUrl(input: string): UrlResult {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return { ok: false, error: "Enter a full URL, for example https://hermes.example.com" };
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackHost(u.hostname))) {
    return { ok: false, error: "Remote connections must use https. Plain http is only allowed for localhost." };
  }
  if (u.username || u.password) return { ok: false, error: "Do not put credentials in the URL." };
  if (u.search || u.hash) return { ok: false, error: "Do not put a query string or fragment in the URL." };
  return { ok: true, url: `${u.origin}${u.pathname.replace(/\/+$/, "")}` };
}

const portOk = (p: unknown) => p === undefined || (Number.isInteger(p) && (p as number) >= 1 && (p as number) <= 65535);

/** Returns the cleaned profile, or null when it is not valid. Unknown fields are dropped. */
export function normalizeProfile(raw: unknown): ConnectionProfile | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !ID.test(o.id)) return null;
  const name = typeof o.name === "string" ? o.name.trim().slice(0, 80) : "";
  if (!name) return null;
  switch (o.kind) {
    case "local":
      return { id: o.id, name, kind: "local" };
    case "remote": {
      if (typeof o.url !== "string" || typeof o.credentialId !== "string" || !ID.test(o.credentialId)) return null;
      const url = validateRemoteUrl(o.url);
      return url.ok ? { id: o.id, name, kind: "remote", url: url.url, credentialId: o.credentialId } : null;
    }
    case "ssh": {
      if (typeof o.host !== "string" || !HOST.test(o.host)) return null;
      if (typeof o.user !== "string" || !SSH_USER.test(o.user)) return null;
      if (!portOk(o.port) || !portOk(o.remotePort)) return null;
      const profile: ConnectionProfile = { id: o.id, name, kind: "ssh", host: o.host, user: o.user };
      if (o.port !== undefined) profile.port = o.port as number;
      if (o.remotePort !== undefined) profile.remotePort = o.remotePort as number;
      return profile;
    }
    default:
      return null;
  }
}

export const LOCAL_PROFILE: ConnectionProfile = { id: "local", name: "This computer", kind: "local" };
