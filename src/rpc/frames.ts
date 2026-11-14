import type { HermesEvent, JsonObject } from "./types";

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

export type IncomingFrame =
  | { kind: "response"; id: number; result?: JsonObject; error?: { code?: number; message: string; data?: unknown } }
  | { kind: "serverRequest"; id: string; method: string; params: JsonObject }
  | { kind: "event"; event: HermesEvent }
  | { kind: "unknown" };

/** Parse one text frame. Never throws; garbage becomes `{kind:"unknown"}`. */
export function parseFrame(text: string): IncomingFrame {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "unknown" };
  }
  if (!isObject(raw)) return { kind: "unknown" };

  if (typeof raw.id === "number" && raw.method === undefined) {
    const err = raw.error;
    if (isObject(err) && typeof err.message === "string") {
      return {
        kind: "response",
        id: raw.id,
        error: { code: typeof err.code === "number" ? err.code : undefined, message: err.message, data: err.data },
      };
    }
    return { kind: "response", id: raw.id, result: isObject(raw.result) ? raw.result : {} };
  }

  if (typeof raw.id === "string" && typeof raw.method === "string") {
    return { kind: "serverRequest", id: raw.id, method: raw.method, params: isObject(raw.params) ? raw.params : {} };
  }

  if (raw.method === "event" && isObject(raw.params) && typeof raw.params.type === "string") {
    return { kind: "event", event: normalizeEvent(raw.params as HermesEvent) };
  }
  return { kind: "unknown" };
}

/** A withdrawn approval/clarify server request becomes `<method>.expire`. */
function normalizeEvent(event: HermesEvent): HermesEvent {
  if (event.type !== "request.cancel" || !isObject(event.payload)) return event;
  const method = event.payload.method;
  if (method !== "approval" && method !== "clarify" && !isPromptMethod(method)) return event;
  return {
    ...event,
    type: isPromptMethod(method) ? "prompt.expire" : `${method as string}.expire`,
    payload: { request_id: event.payload.id ?? "", reason: event.payload.reason ?? "" },
  };
}

/** Value-prompt methods are not yet verified against a live install (issue #3); none are assumed. */
function isPromptMethod(_method: unknown): boolean {
  return false;
}

/**
 * Hermes asks approval and clarify questions as server->client JSON-RPC requests.
 * Project them to `approval.request` / `clarify.request` events. Returns null for
 * methods the app does not handle (the caller must answer with -32601).
 */
export function eventForServerRequest(frame: { id: string; method: string; params: JsonObject }): HermesEvent | null {
  const payload: JsonObject = { ...frame.params };
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined;
  if (frame.method === "approval") {
    // Cancellation identifies the server request; answering identifies the tool approval.
    payload.server_request_id = frame.id;
  } else if (frame.method === "clarify") {
    const first = Array.isArray(payload.questions) && isObject(payload.questions[0]) ? payload.questions[0] : undefined;
    if (payload.question === undefined && first) {
      payload.question = first.question;
      payload.choices = first.choices;
      payload.multi_select = first.multi_select;
    }
    payload.request_id = frame.id;
  } else {
    return null;
  }
  return { type: `${frame.method}.request`, session_id: sessionId ?? "", payload };
}
