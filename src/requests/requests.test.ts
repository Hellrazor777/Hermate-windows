import { describe, expect, it, vi } from "vitest";
import { EventRouter, eventForServerRequest, type HermesEvent } from "../rpc";
import { RequestInbox, type RequestClient } from "./inbox";
import { reduceRequests, type PendingRequest } from "./state";

const ev = (type: string, payload: Record<string, unknown>, session_id = "s1"): HermesEvent => ({ type, session_id, payload });
const approval = (id: string, extra: Record<string, unknown> = {}) =>
  ev("approval.request", { server_request_id: id, command: "rm -rf build", description: "Delete build output", choices: ["once", "session", "deny"], ...extra });

describe("reduceRequests", () => {
  it("adds approvals with the full command and only the offered choices", () => {
    const [r] = reduceRequests([], approval("srq-1"));
    expect(r).toEqual({
      kind: "approval", id: "srq-1", sessionId: "s1",
      command: "rm -rf build", description: "Delete build output", choices: ["once", "session", "deny"],
    });
  });

  it("fails closed to Deny-only when Hermes gives no usable choices", () => {
    for (const choices of [undefined, [], "once", [1, 2]]) {
      const [r] = reduceRequests([], approval("srq-1", { choices }));
      expect(r.kind === "approval" && r.choices).toEqual(["deny"]);
    }
  });

  it("ignores approvals without a request id, and duplicates", () => {
    expect(reduceRequests([], ev("approval.request", { command: "x" }))).toEqual([]);
    const once = reduceRequests([], approval("srq-1"));
    expect(reduceRequests(once, approval("srq-1"))).toBe(once);
  });

  it("parses batch and single-question clarify requests", () => {
    const batch = reduceRequests([], ev("clarify.request", {
      request_id: "srq-2",
      questions: [{ qid: "a", question: "Which?", choices: ["x", "y"], multi_select: true }, { qid: "b", question: "Why?" }],
    }));
    expect(batch[0]).toMatchObject({ kind: "clarify", id: "srq-2" });
    expect((batch[0] as Extract<PendingRequest, { kind: "clarify" }>).questions).toEqual([
      { qid: "a", question: "Which?", choices: ["x", "y"], multiSelect: true },
      { qid: "b", question: "Why?", choices: [], multiSelect: false },
    ]);
    const single = reduceRequests([], ev("clarify.request", { request_id: "srq-3", question: "Sure?", choices: ["yes", "no"] }));
    expect((single[0] as Extract<PendingRequest, { kind: "clarify" }>).questions[0]).toMatchObject({ qid: "q0", question: "Sure?" });
    expect(reduceRequests([], ev("clarify.request", { request_id: "srq-4" }))).toEqual([]); // no question at all
  });

  it("removes a request when Hermes withdraws it", () => {
    const s = reduceRequests(reduceRequests([], approval("srq-1")), approval("srq-2"));
    expect(reduceRequests(s, ev("approval.expire", { request_id: "srq-1", reason: "timeout" })).map((r) => r.id)).toEqual(["srq-2"]);
    expect(reduceRequests(s, ev("approval.expire", {}))).toBe(s);
  });

  it("ignores unrelated events", () => {
    const s: PendingRequest[] = [];
    expect(reduceRequests(s, ev("message.delta", { text: "x" }))).toBe(s);
  });
});

function fake() {
  const router = new EventRouter();
  const client = {
    onEvent: (sid: string | null, h: (e: HermesEvent) => void) => router.subscribe(sid, h),
    answerApproval: vi.fn(),
    answerClarify: vi.fn(),
    declineClarify: vi.fn(),
  } satisfies RequestClient;
  return { client, router };
}

describe("RequestInbox", () => {
  it("collects requests from every session, including events a chat would drop", () => {
    const { client, router } = fake();
    const inbox = new RequestInbox(client);
    router.route(approval("srq-1"));
    router.route(ev("approval.request", { server_request_id: "srq-2", command: "x", choices: ["deny"] }, "other-session"));
    expect(inbox.get().pending.map((r) => [r.id, r.sessionId])).toEqual([["srq-1", "s1"], ["srq-2", "other-session"]]);
  });

  it("answers an approval and removes it", () => {
    const { client, router } = fake();
    const inbox = new RequestInbox(client);
    const seen = vi.fn();
    inbox.subscribe(seen);
    router.route(approval("srq-1"));
    inbox.approve("srq-1", "once");
    expect(client.answerApproval).toHaveBeenCalledWith("srq-1", "once", false);
    expect(inbox.get().pending).toEqual([]);
    expect(seen).toHaveBeenCalled();
  });

  it("refuses an answer Hermes did not offer", () => {
    const { client, router } = fake();
    const inbox = new RequestInbox(client);
    router.route(approval("srq-1", { choices: ["deny"] }));
    inbox.approve("srq-1", "always");
    expect(client.answerApproval).not.toHaveBeenCalled();
    expect(inbox.get().pending).toHaveLength(1); // still blocking: stays visible
    expect(inbox.get().error).toMatch(/not allowed/);
  });

  it("keeps the request visible when sending fails", () => {
    const { client, router } = fake();
    client.answerApproval.mockImplementation(() => {
      throw new Error("The connection to Hermes was lost.");
    });
    const inbox = new RequestInbox(client);
    router.route(approval("srq-1"));
    inbox.approve("srq-1", "deny");
    expect(inbox.get().pending).toHaveLength(1);
    expect(inbox.get().error).toMatch(/lost/);
    client.answerApproval.mockImplementation(() => undefined);
    inbox.approve("srq-1", "deny");
    expect(inbox.get()).toEqual({ pending: [], error: null });
  });

  it("answers and skips clarifications", () => {
    const { client, router } = fake();
    const inbox = new RequestInbox(client);
    router.route(ev("clarify.request", { request_id: "srq-2", questions: [{ qid: "a", question: "Which?" }] }));
    router.route(ev("clarify.request", { request_id: "srq-3", questions: [{ qid: "a", question: "Which?" }] }));
    inbox.answerClarify("srq-2", { a: ["x", "y"] });
    inbox.skipClarify("srq-3");
    expect(client.answerClarify).toHaveBeenCalledWith("srq-2", { a: ["x", "y"] });
    expect(client.declineClarify).toHaveBeenCalledWith("srq-3");
    expect(inbox.get().pending).toEqual([]);
  });

  it("ignores answers for unknown or already-answered requests, and stops after dispose", () => {
    const { client, router } = fake();
    const inbox = new RequestInbox(client);
    inbox.approve("nope", "once");
    inbox.skipClarify("nope");
    expect(client.answerApproval).not.toHaveBeenCalled();
    inbox.dispose();
    router.route(approval("srq-1"));
    expect(inbox.get().pending).toEqual([]);
  });

  it("works end to end with the RPC client's own server-request projection", () => {
    const { client, router } = fake();
    const inbox = new RequestInbox(client);
    const projected = eventForServerRequest({ id: "srq-9", method: "approval", params: { session_id: "s1", command: "ls", description: "List", choices: ["once", "deny"] } });
    router.route(projected as HermesEvent);
    expect(inbox.get().pending[0]).toMatchObject({ kind: "approval", id: "srq-9", command: "ls" });
  });
});
