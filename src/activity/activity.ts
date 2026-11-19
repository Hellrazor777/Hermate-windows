import type { ConnectionStatus } from "../rpc";

/** What the tray icon and edge widget show. */
export type ActivityState = "idle" | "working" | "needs-you" | "finished" | "offline";

export const ACTIVITY_LABELS: Record<ActivityState, string> = {
  idle: "Idle",
  working: "Working",
  "needs-you": "Needs you",
  finished: "Finished",
  offline: "Offline",
};

export interface ActivityInputs {
  connection: ConnectionStatus;
  /** Approval or clarify questions Hermes is blocked on. */
  pendingRequests: number;
  /** A turn is streaming. */
  running: boolean;
  /** A turn finished and nobody has looked at it yet. */
  unseenFinish: boolean;
}

/**
 * One state, by priority: no connection beats everything (nothing else can be trusted), a blocked
 * agent beats a busy one, and "finished" only shows while nothing is running or waiting.
 */
export function deriveActivity(i: ActivityInputs): ActivityState {
  if (i.connection !== "connected") return "offline";
  if (i.pendingRequests > 0) return "needs-you";
  if (i.running) return "working";
  if (i.unseenFinish) return "finished";
  return "idle";
}

/**
 * Remembers a finished turn until it is acknowledged (the user looked at the app, or started
 * another turn). A turn that ended in an error is not "finished": the error is shown in the chat.
 */
export class FinishTracker {
  private wasRunning = false;
  private unseen = false;

  /** Feed the latest chat snapshot; returns whether a finished turn is waiting to be seen. */
  observe(running: boolean, error: string | null): boolean {
    if (this.wasRunning && !running && !error) this.unseen = true;
    if (running) this.unseen = false;
    this.wasRunning = running;
    return this.unseen;
  }

  /** The user looked at the app. */
  acknowledge(): boolean {
    this.unseen = false;
    return false;
  }

  get unseenFinish(): boolean {
    return this.unseen;
  }
}
