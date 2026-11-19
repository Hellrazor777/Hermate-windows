import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { HermesClient } from "../rpc";
import { RequestInbox } from "./inbox";
import type { ClarifyQuestion, PendingRequest } from "./state";

const CHOICE_LABELS: Record<string, string> = {
  once: "Allow once",
  session: "Allow for this session",
  always: "Always allow",
  deny: "Deny",
};

/** Hermes is blocked until these are answered, so they sit above everything else. */
export default function RequestsPanel({ client }: { client: HermesClient }) {
  const inbox = useMemo(() => new RequestInbox(client), [client]);
  useEffect(() => () => inbox.dispose(), [inbox]);
  const { pending, error } = useSyncExternalStore(inbox.subscribe, inbox.get);

  if (pending.length === 0 && !error) return null;
  return (
    <section aria-label="Waiting for you" className="requests">
      <h2>Hermes is waiting for you</h2>
      {error && (
        <p role="alert">
          {error} <button onClick={() => inbox.dismissError()}>Dismiss</button>
        </p>
      )}
      {pending.map((r) =>
        r.kind === "approval" ? (
          <ApprovalCard key={r.id} request={r} onChoose={(c) => inbox.approve(r.id, c)} />
        ) : (
          <ClarifyCard
            key={r.id}
            request={r}
            onSubmit={(answers) => inbox.answerClarify(r.id, answers)}
            onSkip={() => inbox.skipClarify(r.id)}
          />
        ),
      )}
    </section>
  );
}

export function ApprovalCard({
  request,
  onChoose,
}: {
  request: Extract<PendingRequest, { kind: "approval" }>;
  onChoose: (choice: string) => void;
}) {
  // Deny goes last and nothing is focused by default, so Enter cannot approve by accident.
  const ordered = [...request.choices.filter((c) => c !== "deny"), ...request.choices.filter((c) => c === "deny")];
  return (
    <fieldset>
      <legend>Approval needed</legend>
      {request.description && <p>{request.description}</p>}
      {/* The whole command, never truncated: approving something you cannot read is not consent. */}
      <pre className="command">{request.command || "(Hermes sent no command text)"}</pre>
      <div>
        {ordered.map((choice) => (
          <button key={choice} type="button" onClick={() => onChoose(choice)}>
            {CHOICE_LABELS[choice] ?? choice}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function ClarifyCard({
  request,
  onSubmit,
  onSkip,
}: {
  request: Extract<PendingRequest, { kind: "clarify" }>;
  onSubmit: (answers: Record<string, string | string[] | null>) => void;
  onSkip: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const set = (qid: string, value: string | string[]) => setAnswers((a) => ({ ...a, [qid]: value }));

  return (
    <fieldset>
      <legend>Hermes has a question</legend>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const out: Record<string, string | string[] | null> = {};
          for (const q of request.questions) {
            const a = answers[q.qid];
            out[q.qid] = a === undefined || (Array.isArray(a) ? a.length === 0 : a.trim() === "") ? null : a;
          }
          onSubmit(out);
        }}
      >
        {request.questions.map((q) => (
          <Question key={q.qid} q={q} value={answers[q.qid]} onChange={(v) => set(q.qid, v)} />
        ))}
        <button type="submit">Answer</button>{" "}
        <button type="button" onClick={onSkip}>
          Skip
        </button>
      </form>
    </fieldset>
  );
}

function Question({
  q,
  value,
  onChange,
}: {
  q: ClarifyQuestion;
  value: string | string[] | undefined;
  onChange: (v: string | string[]) => void;
}) {
  const selected = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return (
    <div>
      <p>{q.question}</p>
      {q.choices.map((choice) => (
        <label key={choice}>
          <input
            type={q.multiSelect ? "checkbox" : "radio"}
            name={q.qid}
            checked={selected.includes(choice)}
            onChange={(e) =>
              onChange(
                q.multiSelect ? (e.target.checked ? [...selected, choice] : selected.filter((c) => c !== choice)) : choice,
              )
            }
          />{" "}
          {choice}
        </label>
      ))}
      {!q.multiSelect && (
        <input
          type="text"
          aria-label={`Your answer to: ${q.question}`}
          placeholder={q.choices.length > 0 ? "Or type something else" : "Your answer"}
          value={typeof value === "string" && !q.choices.includes(value) ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}
