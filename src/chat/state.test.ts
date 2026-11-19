import { describe, expect, it } from "vitest";
import type { HermesEvent } from "../rpc";
import { addUserMessage, applyDelta, initialChatState, reduce, type ChatItem, type ChatState } from "./state";

const ev = (type: string, payload: Record<string, unknown> = {}): HermesEvent => ({ type, session_id: "s1", payload });
const run = (events: HermesEvent[], from: ChatState = initialChatState) => events.reduce(reduce, from);
const assistants = (s: ChatState) => s.items.filter((i): i is Extract<ChatItem, { kind: "assistant" }> => i.kind === "assistant");

describe("applyDelta", () => {
  it("appends at the end, trims replays, ignores gaps", () => {
    expect(applyDelta("", "ab", 0)).toBe("ab");
    expect(applyDelta("ab", "cd", 2)).toBe("abcd");
    expect(applyDelta("abcd", "cd", 2)).toBe("abcd"); // exact replay
    expect(applyDelta("abc", "bcde", 1)).toBe("abcde"); // overlapping replay: keep only the new tail
    expect(applyDelta("ab", "zz", 5)).toBe("ab"); // gap
    expect(applyDelta("ab", "cd", undefined)).toBe("abcd"); // no identity
  });
  it("counts offsets in UTF-16 units like Hermes does", () => {
    const text = "hi 😀"; // the emoji is 2 UTF-16 units
    expect(applyDelta(text, "!", text.length)).toBe("hi 😀!");
    expect(applyDelta(text, "😀!", 3)).toBe("hi 😀!");
  });
});

describe("reduce: a plain streamed turn (as observed live)", () => {
  it("builds the reply and finishes", () => {
    let s = run([ev("message.start", { turn_id: "t1" }), ev("thinking.delta", { text: "…" })]);
    expect(s).toMatchObject({ running: true, thinking: true, turnId: "t1" });
    s = run([ev("message.delta", { text: "Hel", turn_id: "t1", segment: 0, offset: 0 })], s);
    expect(s.thinking).toBe(false);
    s = run([ev("thinking.delta", { text: "…" })], s); // interleaved: must not re-show thinking
    expect(s.thinking).toBe(false);
    s = run([ev("message.delta", { text: "lo", turn_id: "t1", segment: 0, offset: 3 })], s);
    expect(assistants(s)[0].text).toBe("Hello");
    s = run([ev("message.complete", { text: "Hello", status: "complete" })], s);
    expect(s).toMatchObject({ running: false, thinking: false, turnId: null });
    expect(assistants(s)).toEqual([{ kind: "assistant", id: "t1:0", text: "Hello", sealed: true }]);
  });

  it("is not corrupted by a duplicated (replayed) delta", () => {
    const d = ev("message.delta", { text: "abc", turn_id: "t1", segment: 0, offset: 0 });
    const s = run([ev("message.start", { turn_id: "t1" }), d, d, d]);
    expect(assistants(s)[0].text).toBe("abc");
  });

  it("repairs a missed delta from message.complete", () => {
    const s = run([
      ev("message.start", { turn_id: "t1" }),
      ev("message.delta", { text: "A", turn_id: "t1", segment: 0, offset: 0 }),
      ev("message.delta", { text: "C", turn_id: "t1", segment: 0, offset: 2 }), // offset 1 was lost
      ev("message.complete", { text: "ABC" }),
    ]);
    expect(assistants(s)[0].text).toBe("ABC");
  });

  it("ignores frames from another turn", () => {
    const s = run([
      ev("message.start", { turn_id: "t2" }),
      ev("message.delta", { text: "stale", turn_id: "t1", segment: 0, offset: 0 }),
    ]);
    expect(assistants(s)).toHaveLength(0);
  });
});

describe("reduce: segments and tools", () => {
  it("keeps interim commentary and tool rows in order", () => {
    const s = run([
      ev("message.start", { turn_id: "t1" }),
      ev("message.delta", { text: "Let me look.", turn_id: "t1", segment: 0, offset: 0 }),
      ev("message.interim", { text: "Let me look.", already_streamed: true, turn_id: "t1", segment: 0 }),
      ev("tool.start", { tool_id: "tc1", name: "read_file", preview: "src/a.ts" }),
      ev("tool.complete", { tool_id: "tc1", name: "read_file", summary: "Read 1 file", duration_s: 0.4, result: "BIG SECRET OUTPUT" }),
      ev("message.delta", { text: "Done.", turn_id: "t1", segment: 1, offset: 0 }),
      ev("message.complete", { text: "Done." }),
    ]);
    expect(s.items.map((i) => i.kind)).toEqual(["assistant", "tool", "assistant"]);
    expect(s.items[1]).toEqual({ kind: "tool", id: "tc1", name: "read_file", status: "done", preview: "src/a.ts", summary: "Read 1 file", durationS: 0.4 });
    expect(JSON.stringify(s)).not.toContain("BIG SECRET OUTPUT"); // tool results are not retained
    expect(assistants(s).map((a) => a.text)).toEqual(["Let me look.", "Done."]);
  });

  it("uses interim text when it was not streamed, and tolerates a complete without start", () => {
    let s = run([
      ev("message.start", { turn_id: "t1" }),
      ev("message.interim", { text: "Checking", already_streamed: false, turn_id: "t1", segment: 0 }),
    ]);
    expect(assistants(s)[0]).toMatchObject({ text: "Checking", sealed: true });
    s = run([ev("tool.complete", { tool_id: "late", name: "x" })], s);
    expect(s.items[s.items.length - 1]).toMatchObject({ kind: "tool", id: "late", status: "done" });
  });

  it("uses `context` (the args preview Hermes sends on tool.start) as the row preview", () => {
    const s = run([ev("tool.start", { tool_id: "tc9", name: "terminal", context: "chmod -R 777 /x", args: { command: "chmod -R 777 /x" } })]);
    expect(s.items[0]).toMatchObject({ kind: "tool", name: "terminal", preview: "chmod -R 777 /x" });
  });

  it("does not duplicate a tool row on a repeated tool.start", () => {
    const start = ev("tool.start", { tool_id: "tc1", name: "x" });
    expect(run([start, start]).items).toHaveLength(1);
  });

  it("shows errors and stops running", () => {
    const s = run([ev("message.start", { turn_id: "t1" }), ev("error", { message: "boom" })]);
    expect(s).toMatchObject({ running: false, error: "boom" });
    expect(run([ev("error")]).error).toMatch(/error/i);
  });

  it("ignores unknown events and adds user rows", () => {
    expect(run([ev("notification.show", { text: "x" })])).toBe(initialChatState);
    expect(addUserMessage(initialChatState, "u1", "hi").items).toEqual([{ kind: "user", id: "u1", text: "hi" }]);
  });
});
