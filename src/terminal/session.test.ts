import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
let handler: Handler;
const calls: [string, Record<string, unknown>][] = [];
let lastChannel: { onmessage: (e: unknown) => void } | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (e: unknown) => void = () => undefined;
    constructor() {
      lastChannel = this;
    }
  },
  invoke: (cmd: string, args: Record<string, unknown>) => {
    calls.push([cmd, args]);
    return handler(cmd, args);
  },
}));

import { decodeBase64, TerminalSession, type PtyEvent } from "./session";

const emit = (e: PtyEvent) => lastChannel?.onmessage(e);
const flush = () => new Promise((r) => setTimeout(r, 0));
const make = () => {
  const data: string[] = [];
  const exits: (number | null)[] = [];
  const s = new TerminalSession("cmd", 80, 24, {
    onData: (b) => data.push(new TextDecoder().decode(b)),
    onExit: (c) => exits.push(c),
  });
  return { s, data, exits };
};

beforeEach(() => {
  calls.length = 0;
  lastChannel = null;
  handler = async (cmd) => (cmd === "pty_open" ? 3 : undefined);
});

describe("decodeBase64", () => {
  it("decodes raw bytes, including a UTF-8 sequence", () => {
    expect(Array.from(decodeBase64("aGk="))).toEqual([104, 105]);
    expect(new TextDecoder().decode(decodeBase64("w6k="))).toBe("é");
  });
});

describe("TerminalSession", () => {
  it("opens with the shell name and size, never a program path", () => {
    make();
    expect(calls[0][0]).toBe("pty_open");
    expect(calls[0][1]).toMatchObject({ shell: "cmd", cols: 80, rows: 24 });
  });

  it("delivers output as bytes and reports one exit", () => {
    const { data, exits } = make();
    emit({ event: "data", data: "aGk=" });
    emit({ event: "exit", code: 0 });
    emit({ event: "exit", code: 1 });
    expect(data).toEqual(["hi"]);
    expect(exits).toEqual([0]);
  });

  it("writes and resizes in order once the id is known", async () => {
    let open: (id: number) => void = () => undefined;
    handler = (cmd) => (cmd === "pty_open" ? new Promise<number>((r) => (open = r)) : Promise.resolve(undefined));
    const { s } = make();
    s.write("a");
    s.resize(100, 30);
    s.write("b");
    await flush();
    expect(calls.filter(([c]) => c !== "pty_open")).toHaveLength(0);
    open(3);
    await flush();
    await flush();
    await flush();
    expect(calls.filter(([c]) => c !== "pty_open").map(([c, a]) => [c, a.id, a.text ?? a.cols])).toEqual([
      ["pty_write", 3, "a"],
      ["pty_resize", 3, 100],
      ["pty_write", 3, "b"],
    ]);
  });

  it("a refused open ends the terminal with the reason", async () => {
    handler = async (cmd) => {
      if (cmd === "pty_open") throw "too many open terminals";
      return undefined;
    };
    const { s, exits } = make();
    await flush();
    await flush();
    expect(exits).toEqual([null]);
    expect(s.failure).toBe("too many open terminals");
  });

  it("does not write after the shell exited, and close asks Rust to kill it", async () => {
    const { s } = make();
    await flush();
    emit({ event: "exit", code: 0 });
    s.write("late");
    s.close();
    await flush();
    await flush();
    expect(calls.some(([c]) => c === "pty_write")).toBe(false);
    expect(calls.some(([c, a]) => c === "pty_close" && a.id === 3)).toBe(true);
  });
});
