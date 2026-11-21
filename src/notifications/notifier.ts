import type { ActivityState } from "../activity/activity";

export interface Notice {
  title: string;
  body: string;
}

export interface NotifierInput {
  state: ActivityState;
  /** Ids of the approval and clarify requests Hermes is waiting on right now. */
  pendingIds: readonly string[];
  /** The Hermate window has the keyboard focus: the person is already looking at it. */
  focused: boolean;
  /** The "Notifications" preference. */
  enabled: boolean;
}

/**
 * Decides when to tell the person something while they are away. Kept free of any delivery code so
 * the rules are testable:
 *  - a request that needs an answer is announced once (never again for the same id), and not at all while the window is focused;
 *  - a finished turn is announced once, when the state becomes "finished" (the activity state only gets there while nobody is looking);
 *  - nothing is sent while the preference is off, but what happened meanwhile is still remembered, so turning it on never replays old events.
 *
 * Text is deliberately generic. A notification can show on a lock screen or in a screen share, so it never carries the reply text,
 * a command, or a question: the person opens the app to see those.
 */
export class Notifier {
  private announced = new Set<string>();
  private lastState: ActivityState | null = null;

  observe(input: NotifierInput): Notice[] {
    const notices: Notice[] = [];
    const fresh = input.pendingIds.filter((id) => !this.announced.has(id));
    // Forget answered requests so the set cannot grow without bound.
    this.announced = new Set(input.pendingIds);

    if (input.enabled && !input.focused && fresh.length > 0) {
      notices.push({
        title: "Hermes needs you",
        body: fresh.length === 1 ? "An approval or question is waiting." : `${fresh.length} approvals or questions are waiting.`,
      });
    }
    if (input.enabled && input.state === "finished" && this.lastState !== "finished") {
      notices.push({ title: "Hermes finished", body: "A reply is ready." });
    }
    this.lastState = input.state;
    return notices;
  }
}
