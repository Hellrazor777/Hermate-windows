/** JSON object as it crosses the wire. */
export type JsonObject = Record<string, unknown>;

export type ConnectionStatus = "idle" | "connecting" | "connected" | "reconnecting" | "closed";

/** A streamed event: `{method:"event", params:{type, session_id?, payload?}}`. */
export interface HermesEvent {
  type: string;
  session_id?: string;
  payload?: JsonObject;
  [key: string]: unknown;
}

/** Event types the app currently handles. Unknown types are still delivered as plain strings. */
export const KnownEventTypes = {
  ApprovalRequest: "approval.request",
  ApprovalExpire: "approval.expire",
  ClarifyRequest: "clarify.request",
  ClarifyExpire: "clarify.expire",
  PromptRequest: "prompt.request",
  PromptExpire: "prompt.expire",
} as const;

export class HermesRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "HermesRpcError";
  }
}

export class HermesDisconnectedError extends HermesRpcError {
  constructor(message = "The connection to Hermes was lost.") {
    super(message);
    this.name = "HermesDisconnectedError";
  }
}

export class HermesTimeoutError extends HermesRpcError {
  constructor(method: string) {
    super(`Hermes did not respond to ${method} in time.`, 408);
    this.name = "HermesTimeoutError";
  }
}

export class HermesAuthError extends HermesRpcError {
  constructor(message = "A Hermes token is required to connect.") {
    super(message);
    this.name = "HermesAuthError";
  }
}
