import { Channel, invoke } from "@tauri-apps/api/core";

export const SHELLS = ["powershell", "cmd"] as const;
export type Shell = (typeof SHELLS)[number];

/** What the Rust side (`pty.rs`) streams for one terminal. */
export type PtyEvent = { event: "data"; data: string } | { event: "exit"; code: number | null };

export interface TerminalHandlers {
  onData: (bytes: Uint8Array) => void;
  onExit: (code: number | null) => void;
}

/** Raw PTY bytes arrive as base64 (they can split a UTF-8 sequence, so xterm decodes them). */
export function decodeBase64(data: string): Uint8Array {
  const bin = atob(data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** One local shell running in a ConPTY on the Rust side. */
export class TerminalSession {
  private id: Promise<number>;
  private queue: Promise<unknown>;
  private exited = false;

  constructor(shell: Shell, cols: number, rows: number, private handlers: TerminalHandlers) {
    const channel = new Channel<PtyEvent>();
    channel.onmessage = (e) => this.handle(e);
    this.id = invoke<number>("pty_open", { shell, cols, rows, onEvent: channel });
    this.queue = this.id.catch(() => undefined);
    this.id.catch((e: unknown) => {
      // Refused or failed to start: surface it as an ended terminal.
      this.failure = typeof e === "string" ? e : "could not start the terminal";
      this.handle({ event: "exit", code: null });
    });
  }

  /** Set when the terminal could not start; for display. */
  failure: string | null = null;

  /** Keystrokes and pasted text, in order. */
  write(text: string): void {
    this.enqueue((id) => invoke("pty_write", { id, text }));
  }

  resize(cols: number, rows: number): void {
    this.enqueue((id) => invoke("pty_resize", { id, cols, rows }));
  }

  close(): void {
    void this.id.then((id) => invoke("pty_close", { id })).catch(() => undefined);
  }

  private enqueue(call: (id: number) => Promise<unknown>): void {
    this.queue = this.queue.then(async () => {
      if (this.exited) return;
      try {
        await call(await this.id);
      } catch {
        // The shell is gone; the exit event reports it.
      }
    });
  }

  private handle(e: PtyEvent): void {
    if (e.event === "data") {
      this.handlers.onData(decodeBase64(e.data));
    } else if (!this.exited) {
      this.exited = true;
      this.handlers.onExit(e.code);
    }
  }
}
