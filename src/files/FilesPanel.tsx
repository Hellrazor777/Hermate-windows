import { useEffect, useSyncExternalStore } from "react";
import type { FileEntry, FilesStore } from "./store";

const kb = (n: number | null) => (n === null ? "" : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const when = (s: number | null) => (s ? new Date(s * 1000).toLocaleString() : "");

/** Browse the connected Hermes machine's files, read-only: open folders, preview text and small images. */
export default function FilesPanel({ store }: { store: FilesStore }) {
  const { path, parent, entries, preview, loading, error } = useSyncExternalStore(store.subscribe, store.get);

  useEffect(() => {
    void store.list();
  }, [store]);

  const label = (e: FileEntry) => (e.isDirectory ? `${e.name}/` : e.name);

  return (
    <section aria-label="Files">
      <h2>Files</h2>
      <button disabled={!parent || loading} onClick={() => void store.up()}>
        Up
      </button>{" "}
      <button disabled={loading} onClick={() => void store.refresh()}>
        {loading ? "Loading…" : "Refresh"}
      </button>
      {path && (
        <p className="muted" aria-label="Current folder">
          {path}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {path && !loading && entries.length === 0 && !error && <p className="muted">This folder is empty.</p>}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {entries.map((e) => (
          <li key={e.path}>
            <button aria-label={e.isDirectory ? `Open folder ${e.name}` : `Preview ${e.name}`} onClick={() => void store.open(e)}>
              {label(e)}
            </button>{" "}
            <span className="muted">
              {kb(e.size)} {when(e.mtime)}
            </span>
          </li>
        ))}
      </ul>

      {preview && (
        <article aria-label="File preview">
          <h3>{preview.name}</h3>
          <p className="muted">{preview.path}</p>
          {preview.kind === "text" && (
            <pre style={{ whiteSpace: "pre-wrap", maxHeight: 360, overflow: "auto" }}>{preview.text}</pre>
          )}
          {preview.kind === "image" && <img alt={preview.name} src={preview.dataUrl} style={{ maxWidth: "100%", maxHeight: 360 }} />}
          {preview.kind === "none" && <p>{preview.reason}</p>}
          <button onClick={() => store.closePreview()}>Close preview</button>
        </article>
      )}
    </section>
  );
}
