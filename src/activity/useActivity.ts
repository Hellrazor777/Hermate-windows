import { useEffect, useMemo, useRef, useState } from "react";
import type { HermesClient } from "../rpc";
import type { Services } from "../services";
import { ACTIVITY_LABELS, deriveActivity, FinishTracker, type ActivityState } from "./activity";

/** What the tray and the edge widget need; plain data so it can cross the window boundary. */
export interface ActivitySnapshot {
  state: ActivityState;
  label: string;
  /** Approvals and questions Hermes is waiting on. */
  pending: number;
  /** The start of the latest assistant reply, as plain text. */
  reply: string;
}

export const OFFLINE_SNAPSHOT: ActivitySnapshot = { state: "offline", label: ACTIVITY_LABELS.offline, pending: 0, reply: "" };

const REPLY_CHARS = 240;

/** Combine connection status, the running turn and pending requests into one snapshot. */
export function useActivity(client: HermesClient | null, services: Services | null): ActivitySnapshot {
  const [tick, setTick] = useState(0);
  const tracker = useRef(new FinishTracker());
  const bump = () => setTick((n) => n + 1);

  // A finished turn counts as seen when the window is focused: on focus, or if it already was.
  useEffect(() => {
    const seen = () => {
      tracker.current.acknowledge();
      bump();
    };
    window.addEventListener("focus", seen);
    return () => window.removeEventListener("focus", seen);
  }, []);

  useEffect(() => {
    if (!client) return;
    return client.onStatus(bump);
  }, [client]);

  useEffect(() => {
    if (!services) return;
    const offChat = services.chat.subscribe(() => {
      const s = services.chat.get();
      tracker.current.observe(s.running, s.error);
      if (tracker.current.unseenFinish && document.hasFocus()) tracker.current.acknowledge();
      bump();
    });
    const offInbox = services.inbox.subscribe(bump);
    return () => {
      offChat();
      offInbox();
    };
  }, [services]);

  return useMemo(() => {
    void tick; // recompute on every notification above
    if (!client) return OFFLINE_SNAPSHOT;
    const chat = services?.chat.get();
    const pending = services?.inbox.get().pending.length ?? 0;
    const state = deriveActivity({
      connection: client.connectionStatus,
      pendingRequests: pending,
      running: chat?.running ?? false,
      unseenFinish: tracker.current.unseenFinish,
    });
    const lastReply = chat ? [...chat.items].reverse().find((i) => i.kind === "assistant") : undefined;
    const reply = lastReply && lastReply.kind === "assistant" ? lastReply.text.slice(0, REPLY_CHARS) : "";
    return { state, label: ACTIVITY_LABELS[state], pending, reply };
  }, [client, services, tick]);
}
