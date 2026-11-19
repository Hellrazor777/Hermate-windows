import type { HermesEvent } from "../rpc";

/**
 * Transcript state driven by Hermes events (semantics read from the Hermes source and verified
 * live for the text stream; see docs/PROTOCOL.md). Hermes is authoritative: the transcript is a
 * projection of its events, and `message.complete` replaces streamed text with the final text.
 */
export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; sealed: boolean }
  | { kind: "tool"; id: string; name: string; status: "running" | "done"; preview?: string; summary?: string; durationS?: number };

export interface ChatState {
  items: ChatItem[];
  running: boolean;
  /** Hermes is reasoning and has not produced text yet. */
  thinking: boolean;
  /** The turn whose frames are being applied; frames of other turns are ignored. */
  turnId: string | null;
  error: string | null;
}

export const initialChatState: ChatState = { items: [], running: false, thinking: false, turnId: null, error: null };

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * Apply one text delta. `offset` is the UTF-16 index of the delta inside its segment, which is
 * exactly a JavaScript string index. Append only at the current end; trim a replayed overlap;
 * ignore a gap (the final `message.complete` text repairs it).
 */
export function applyDelta(current: string, text: string, offset: number | undefined): string {
  if (offset === undefined) return current + text; // older backend: no identity, plain append
  if (offset === current.length) return current + text;
  if (offset < current.length) {
    const skip = current.length - offset;
    return skip >= text.length ? current : current + text.slice(skip);
  }
  return current;
}

function upsertAssistant(items: ChatItem[], id: string, change: (text: string) => string, seal = false): ChatItem[] {
  const i = items.findIndex((it) => it.kind === "assistant" && it.id === id);
  if (i === -1) {
    const text = change("");
    return [...items, { kind: "assistant", id, text, sealed: seal }];
  }
  const prev = items[i] as Extract<ChatItem, { kind: "assistant" }>;
  const next = { ...prev, text: change(prev.text), sealed: prev.sealed || seal };
  return items.map((it, j) => (j === i ? next : it));
}

/** Adopt a turn id from a frame, or reject a frame that belongs to a different turn. */
function acceptTurn(state: ChatState, turnId: string | undefined): boolean {
  return !turnId || !state.turnId || state.turnId === turnId;
}

export function reduce(state: ChatState, event: HermesEvent): ChatState {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "message.start":
      return { ...state, running: true, thinking: true, turnId: str(p.turn_id) ?? null, error: null };

    case "thinking.delta":
    case "reasoning.delta": {
      // Hermes interleaves thinking deltas with text; only show "thinking" before any reply text.
      const turn = state.turnId ?? "";
      const hasText = state.items.some((it) => it.kind === "assistant" && it.id.startsWith(`${turn}:`) && it.text !== "");
      return state.thinking || hasText ? state : { ...state, running: true, thinking: true };
    }

    case "message.delta": {
      const text = str(p.text);
      if (text === undefined || !acceptTurn(state, str(p.turn_id))) return state;
      const turnId = state.turnId ?? str(p.turn_id) ?? "turn";
      const segment = num(p.segment) ?? 0;
      const id = `${turnId}:${segment}`;
      return {
        ...state,
        running: true,
        thinking: false,
        turnId: state.turnId ?? str(p.turn_id) ?? null,
        items: upsertAssistant(state.items, id, (cur) => applyDelta(cur, text, num(p.offset))),
      };
    }

    case "message.interim": {
      // Commentary beside tool calls: seals the segment it names.
      if (!acceptTurn(state, str(p.turn_id))) return state;
      const turnId = state.turnId ?? str(p.turn_id) ?? "turn";
      const id = `${turnId}:${num(p.segment) ?? 0}`;
      const text = str(p.text);
      const already = p.already_streamed === true;
      return {
        ...state,
        items: upsertAssistant(state.items, id, (cur) => (already || text === undefined ? cur : text), true),
      };
    }

    case "message.complete": {
      const text = str(p.text);
      const turnId = state.turnId ?? "turn";
      // The final text belongs to the last open segment: the highest-numbered one for this turn.
      const mine = state.items.filter((it) => it.kind === "assistant" && it.id.startsWith(`${turnId}:`));
      const last = mine.length ? (mine[mine.length - 1] as Extract<ChatItem, { kind: "assistant" }>).id : `${turnId}:0`;
      const items =
        text !== undefined && text !== "" ? upsertAssistant(state.items, last, () => text, true) : state.items;
      return { ...state, items: sealAll(items, turnId), running: false, thinking: false, turnId: null };
    }

    case "tool.start": {
      const id = str(p.tool_id);
      if (!id) return state;
      if (state.items.some((it) => it.kind === "tool" && it.id === id)) return state;
      const tool: ChatItem = { kind: "tool", id, name: str(p.name) ?? "tool", status: "running", preview: str(p.preview) };
      return { ...state, thinking: false, items: [...state.items, tool] };
    }

    case "tool.complete": {
      const id = str(p.tool_id);
      if (!id) return state;
      // Deliberately not keeping `result`: it can be large and may hold sensitive output.
      const patch = { status: "done" as const, summary: str(p.summary), durationS: num(p.duration_s) };
      const exists = state.items.some((it) => it.kind === "tool" && it.id === id);
      const items = exists
        ? state.items.map((it) => (it.kind === "tool" && it.id === id ? { ...it, ...patch } : it))
        : [...state.items, { kind: "tool" as const, id, name: str(p.name) ?? "tool", ...patch }];
      return { ...state, items };
    }

    case "error":
      return { ...state, running: false, thinking: false, turnId: null, error: str(p.message) ?? "Hermes reported an error." };

    default:
      return state;
  }
}

function sealAll(items: ChatItem[], turnId: string): ChatItem[] {
  return items.map((it) => (it.kind === "assistant" && it.id.startsWith(`${turnId}:`) ? { ...it, sealed: true } : it));
}

/** A user row Hermes accepted (`prompt.submit` succeeded). */
export function addUserMessage(state: ChatState, id: string, text: string): ChatState {
  return { ...state, items: [...state.items, { kind: "user", id, text }], error: null };
}
