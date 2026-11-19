import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChatController } from "./controller";
import Markdown from "./Markdown";

export default function ChatView({ chat }: { chat: ChatController }) {
  const state = useSyncExternalStore(chat.subscribe, chat.get);
  const [draft, setDraft] = useState("");
  const end = useRef<HTMLDivElement>(null);

  // Keep the newest content in view while streaming.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [state.items, state.thinking]);

  function submit() {
    const text = draft;
    if (!text.trim() || state.running) return;
    setDraft("");
    void chat.send(text);
  }

  return (
    <section className="chat">
      <h2>Chat</h2>
      <div className="transcript" aria-live="polite">
        {state.items.map((item) => {
          if (item.kind === "user") {
            return (
              <div key={item.id} className="msg user">
                {item.text}
              </div>
            );
          }
          if (item.kind === "tool") {
            return (
              <div key={item.id} className="msg tool muted">
                {item.status === "running" ? "⏳" : "✓"} {item.name}
                {item.preview ? ` · ${item.preview}` : ""}
                {item.summary ? ` · ${item.summary}` : ""}
                {item.durationS !== undefined ? ` · ${item.durationS.toFixed(1)}s` : ""}
              </div>
            );
          }
          return (
            <div key={item.id} className="msg assistant">
              <Markdown text={item.text} />
            </div>
          );
        })}
        {state.thinking && <div className="msg muted">Thinking…</div>}
        {state.error && <div role="alert" className="msg error">{state.error}</div>}
        <div ref={end} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          value={draft}
          rows={3}
          placeholder="Message Hermes… (Enter to send, Shift+Enter for a new line)"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {state.running ? (
          <button type="button" onClick={() => void chat.interrupt()}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!draft.trim()}>
            Send
          </button>
        )}
      </form>
    </section>
  );
}
