import type { HermesEvent } from "../rpc";

/**
 * Questions Hermes is waiting on: tool approvals and clarifications. Hermes sends them as
 * server->client requests (projected to `approval.request` / `clarify.request` events by the RPC
 * client) and withdraws them with `*.expire`. The agent is blocked until each is answered.
 */
export interface ClarifyQuestion {
  qid: string;
  question: string;
  choices: string[];
  multiSelect: boolean;
}

export type PendingRequest =
  | {
      kind: "approval";
      /** The `srq-…` id the response frame must carry. */
      id: string;
      sessionId: string;
      /** The full, untruncated command Hermes wants to run (Hermes redacts secrets before sending). */
      command: string;
      description: string;
      /** Only these answers may be offered; Hermes decides (for example deny-only). */
      choices: string[];
    }
  | { kind: "clarify"; id: string; sessionId: string; questions: ClarifyQuestion[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function parseQuestions(p: Record<string, unknown>): ClarifyQuestion[] {
  const raw = Array.isArray(p.questions) ? p.questions : [];
  const parsed = raw.filter(isObj).map((q, i) => ({
    qid: str(q.qid) ?? `q${i}`,
    question: str(q.question) ?? "",
    choices: strings(q.choices),
    multiSelect: q.multi_select === true,
  }));
  if (parsed.length > 0) return parsed;
  // Single-question shape (older backends, and the fields the client projects from the first question).
  const question = str(p.question);
  return question === undefined
    ? []
    : [{ qid: "q0", question, choices: strings(p.choices), multiSelect: p.multi_select === true }];
}

export function reduceRequests(state: PendingRequest[], event: HermesEvent): PendingRequest[] {
  const p = isObj(event.payload) ? event.payload : {};
  const sessionId = str(event.session_id) ?? "";
  switch (event.type) {
    case "approval.request": {
      const id = str(p.server_request_id);
      if (!id || state.some((r) => r.id === id)) return state;
      return [
        ...state,
        {
          kind: "approval",
          id,
          sessionId,
          command: str(p.command) ?? "",
          description: str(p.description) ?? "",
          // Fail closed: with no usable choices list, offer only Deny.
          choices: strings(p.choices).length > 0 ? strings(p.choices) : ["deny"],
        },
      ];
    }
    case "clarify.request": {
      const id = str(p.request_id);
      const questions = parseQuestions(p);
      if (!id || questions.length === 0 || state.some((r) => r.id === id)) return state;
      return [...state, { kind: "clarify", id, sessionId, questions }];
    }
    case "approval.expire":
    case "clarify.expire": {
      const id = str(p.request_id);
      return id ? state.filter((r) => r.id !== id) : state;
    }
    default:
      return state;
  }
}
