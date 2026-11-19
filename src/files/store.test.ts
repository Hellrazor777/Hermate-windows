import { describe, expect, it } from "vitest";
import { HermesRpcError } from "../rpc";
import {
  decodeDataUrl,
  decodeText,
  FilesStore,
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
  parseEntries,
  type FileEntry,
  type FilesClient,
} from "./store";

/** A row exactly as `GET /api/files` returned it live. */
const row = (over: Record<string, unknown> = {}) => ({
  name: "notes.txt",
  path: "C:\\Users\\Chris\\notes.txt",
  is_directory: false,
  size: 12,
  mtime: 1789297272.5,
  mime_type: "text/plain",
  ...over,
});

const dir = (name: string) => row({ name, path: `C:\\Users\\Chris\\${name}`, is_directory: true, size: null, mime_type: null });

const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");
const read = (mime: string, bytes: string | Uint8Array, over: Record<string, unknown> = {}) => ({
  name: "x",
  path: "C:\\x",
  size: typeof bytes === "string" ? bytes.length : bytes.length,
  mime_type: mime,
  data_url: `data:${mime};base64,${b64(bytes)}`,
  ...over,
});

type Call = { method: string; path: string };

function fake(handler: (c: Call) => unknown) {
  const calls: Call[] = [];
  const client: FilesClient = {
    pluginRequest: async (method, path) => {
      calls.push({ method, path });
      return (await handler({ method, path })) as Record<string, never>;
    },
  };
  return { client, calls };
}

const listing = (path: string, parent: string | null, entries: unknown[]) => ({ path, parent, entries, root: null, locked_root: null, can_change_path: true });

const entry = (over: Partial<FileEntry> = {}): FileEntry => ({
  name: "notes.txt",
  path: "C:\\Users\\Chris\\notes.txt",
  isDirectory: false,
  size: 12,
  mime: "text/plain",
  mtime: 1,
  ...over,
});

describe("parsers", () => {
  it("reads live rows and drops junk", () => {
    expect(parseEntries([row(), dir("src"), null, "x", { name: "no path" }])).toEqual([
      { name: "notes.txt", path: "C:\\Users\\Chris\\notes.txt", isDirectory: false, size: 12, mime: "text/plain", mtime: 1789297272.5 },
      { name: "src", path: "C:\\Users\\Chris\\src", isDirectory: true, size: null, mime: null, mtime: 1789297272.5 },
    ]);
    expect(parseEntries(undefined)).toEqual([]);
  });

  it("decodes data URLs and refuses other shapes", () => {
    expect(decodeDataUrl(`data:text/plain;base64,${b64("hi")}`)).toEqual({ mime: "text/plain", bytes: new TextEncoder().encode("hi") });
    expect(decodeDataUrl("data:text/plain,hi")).toBeNull();
    expect(decodeDataUrl("https://x/y")).toBeNull();
    expect(decodeDataUrl("data:text/plain;base64,@@@")).toBeNull();
  });

  it("treats NUL bytes and invalid UTF-8 as binary, and keeps real text", () => {
    expect(decodeText(new TextEncoder().encode("héllo ✓"))).toBe("héllo ✓");
    expect(decodeText(new Uint8Array([104, 0, 105]))).toBeNull();
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull();
  });
});

describe("FilesStore", () => {
  it("lists Hermes' starting folder when no path is given", async () => {
    const { client, calls } = fake(() => listing("C:\\Users\\Chris", "C:\\Users", [dir("src"), row()]));
    const store = new FilesStore(client);
    await store.list();
    expect(calls).toEqual([{ method: "GET", path: "/api/files" }]);
    expect(store.get()).toMatchObject({ path: "C:\\Users\\Chris", parent: "C:\\Users", loading: false, error: null });
    expect(store.get().entries).toHaveLength(2);
  });

  it("opens a folder and goes up, encoding Windows paths in the query", async () => {
    const { client, calls } = fake((c) =>
      c.path === "/api/files" ? listing("C:\\Users\\Chris", "C:\\Users", [dir("my docs")]) : listing("C:\\Users\\Chris\\my docs", "C:\\Users\\Chris", []),
    );
    const store = new FilesStore(client);
    await store.list();
    await store.open(store.get().entries[0]);
    expect(calls[1].path).toBe("/api/files?path=C%3A%5CUsers%5CChris%5Cmy%20docs");
    expect(store.get().path).toBe("C:\\Users\\Chris\\my docs");
    await store.up();
    expect(calls[2].path).toBe("/api/files?path=C%3A%5CUsers%5CChris");
  });

  it("does nothing on Up at the top", async () => {
    const { client, calls } = fake(() => listing("C:\\", null, []));
    const store = new FilesStore(client);
    await store.list();
    await store.up();
    expect(calls).toHaveLength(1);
  });

  it("stays on the current folder and shows Hermes' reason when a folder cannot be opened", async () => {
    let fail = false;
    const { client } = fake(() => {
      if (fail) throw new HermesRpcError("Directory is not readable", 403);
      return listing("C:\\a", null, [row()]);
    });
    const store = new FilesStore(client);
    await store.list();
    fail = true;
    await store.list("C:\\secret");
    expect(store.get()).toMatchObject({ path: "C:\\a", error: "Directory is not readable", loading: false });
    expect(store.get().entries).toHaveLength(1);
  });

  it("previews a text file", async () => {
    const { client, calls } = fake(() => read("text/plain", "hello\nworld"));
    const store = new FilesStore(client);
    await store.open(entry());
    expect(calls[0].path).toBe("/api/files/read?path=C%3A%5CUsers%5CChris%5Cnotes.txt");
    expect(store.get().preview).toMatchObject({ kind: "text", text: "hello\nworld", name: "notes.txt" });
    store.closePreview();
    expect(store.get().preview).toBeNull();
  });

  it("previews a small raster image but never an SVG", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 0, 1, 2]);
    const store = new FilesStore(fake(() => read("image/png", png)).client);
    await store.open(entry({ name: "a.png", mime: "image/png", size: png.length }));
    expect(store.get().preview).toMatchObject({ kind: "image" });
    const svg = new FilesStore(fake(() => read("image/svg+xml", "<svg onload='x()'/>")).client);
    await svg.open(entry({ name: "a.svg", mime: "image/svg+xml", size: 20 }));
    expect(svg.get().preview).toMatchObject({ kind: "text" }); // shown as source text, never rendered
  });

  it("refuses binary data without showing it", async () => {
    const store = new FilesStore(fake(() => read("application/octet-stream", new Uint8Array([1, 0, 2, 0]))).client);
    await store.open(entry({ name: "a.bin", mime: "application/octet-stream", size: 4 }));
    expect(store.get().preview).toMatchObject({ kind: "none", reason: expect.stringMatching(/binary/) });
  });

  it("does not download a file the list already says is too large", async () => {
    const { client, calls } = fake(() => read("text/plain", "x"));
    const store = new FilesStore(client);
    await store.open(entry({ size: MAX_TEXT_BYTES + 1 }));
    expect(calls).toHaveLength(0);
    expect(store.get().preview).toMatchObject({ kind: "none", reason: expect.stringMatching(/too large/) });
    await store.open(entry({ name: "p.png", mime: "image/png", size: MAX_IMAGE_BYTES + 1 }));
    expect(calls).toHaveLength(0);
    await store.open(entry({ name: "p.png", mime: "image/png", size: MAX_IMAGE_BYTES }));
    expect(calls).toHaveLength(1);
  });

  it("shows a refusal to read (for example a sensitive file) and keeps the folder", async () => {
    const { client } = fake((c) => {
      if (c.path.startsWith("/api/files/read")) throw new HermesRpcError("Access to sensitive files is not allowed", 403);
      return listing("C:\\a", null, [row()]);
    });
    const store = new FilesStore(client);
    await store.list();
    await store.open(store.get().entries[0]);
    expect(store.get().error).toBe("Access to sensitive files is not allowed");
    expect(store.get().entries).toHaveLength(1);
  });

  it("an older request never overwrites a newer one, and nothing updates after dispose", async () => {
    const resolvers: ((v: unknown) => void)[] = [];
    const { client } = fake(() => new Promise((r) => resolvers.push(r)));
    const store = new FilesStore(client);
    const first = store.list("C:\\old");
    const second = store.list("C:\\new");
    resolvers[1](listing("C:\\new", null, []));
    await second;
    resolvers[0](listing("C:\\old", null, []));
    await first;
    expect(store.get().path).toBe("C:\\new");

    let notified = 0;
    store.subscribe(() => notified++);
    store.dispose();
    const third = store.list("C:\\x");
    resolvers[2](listing("C:\\x", null, []));
    await third;
    expect(notified).toBe(0);
  });
});
