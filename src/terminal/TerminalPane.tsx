import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { SHELLS, TerminalSession, type Shell } from "./session";

/** A local shell in the app. Starts on demand; closing it (or the app) ends the shell. */
export default function TerminalPane() {
  const [shell, setShell] = useState<Shell>("powershell");
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!running || !host.current) return;
    const term = new Terminal({
      fontFamily: "Cascadia Mono, Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();

    const session = new TerminalSession(shell, term.cols, term.rows, {
      onData: (bytes) => term.write(bytes),
      onExit: (code) => {
        setNote(session.failure ?? `The shell exited${code === null ? "" : ` (code ${code})`}.`);
        setRunning(false);
      },
    });
    // Keystrokes (and xterm's own replies to the shell's queries) go to the shell.
    const input = term.onData((text) => session.write(text));
    const resize = term.onResize(({ cols, rows }) => session.resize(cols, rows));
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host.current);

    return () => {
      observer.disconnect();
      input.dispose();
      resize.dispose();
      session.close();
      term.dispose();
    };
  }, [running, shell]);

  return (
    <fieldset>
      <legend>Terminal</legend>
      <label>
        Shell{" "}
        <select value={shell} disabled={running} onChange={(e) => setShell(e.target.value as Shell)}>
          {SHELLS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>{" "}
      <button
        onClick={() => {
          setNote(null);
          setRunning((r) => !r);
        }}
      >
        {running ? "Stop terminal" : "Start terminal"}
      </button>
      {note && <p className="muted">{note}</p>}
      {running && <div ref={host} className="terminal-host" aria-label="Terminal" />}
    </fieldset>
  );
}
