import { useEffect, useState } from "react";
import { announceWidgetReady, EVENTS, onEvent, sendQuickMessage, showMainWindow } from "../activity/bridge";
import { OFFLINE_SNAPSHOT, type ActivitySnapshot } from "../activity/useActivity";

/** Shapes as well as colours, so the state never depends on colour alone. */
const SYMBOL: Record<ActivitySnapshot["state"], string> = {
  idle: "●",
  working: "◐",
  "needs-you": "!",
  finished: "✓",
  offline: "○",
};

/**
 * The edge widget. It holds no connection: the main window pushes the current state in, and a
 * quick message goes back out as an event. Approvals are deliberately NOT answerable here
 * (the widget cannot show a whole command); it only points you at the main window.
 */
export default function Widget() {
  const [snap, setSnap] = useState<ActivitySnapshot>(OFFLINE_SNAPSHOT);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    let off: (() => void) | undefined;
    let cancelled = false;
    void onEvent<ActivitySnapshot>(EVENTS.activity, setSnap).then((un) => {
      if (cancelled) un();
      else off = un;
    });
    void announceWidgetReady();
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const canSend = snap.state === "idle" || snap.state === "finished";

  function submit() {
    const text = draft.trim();
    if (!text || !canSend) return;
    setDraft("");
    void sendQuickMessage(text);
  }

  return (
    <div className="widget" data-state={snap.state}>
      <div className="widget-head">
        <span className={`widget-dot ${snap.state}`} aria-hidden="true">
          {SYMBOL[snap.state]}
        </span>
        <strong>{snap.label}</strong>
        <button type="button" onClick={() => void showMainWindow()}>
          Open
        </button>
      </div>

      {snap.state === "needs-you" && (
        <p>
          Hermes is waiting on {snap.pending} {snap.pending === 1 ? "question" : "questions"}. Open Hermate to answer.
        </p>
      )}
      {snap.reply && snap.state !== "needs-you" && <p className="widget-reply">{snap.reply}</p>}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          value={draft}
          disabled={!canSend}
          placeholder={snap.state === "offline" ? "Not connected" : snap.state === "working" ? "Working…" : "Quick message…"}
          aria-label="Quick message"
          onChange={(e) => setDraft(e.target.value)}
        />
      </form>
    </div>
  );
}
