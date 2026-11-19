import { describe, expect, it } from "vitest";
import { HermesClient, type WebSocketLike } from "../rpc";
import { ChatController } from "./controller";

/**
 * Opt-in end-to-end chat test. MAKES ONE REAL MODEL CALL and creates one session (which it deletes).
 * Skipped unless all three variables are set:
 *   HERMES_LIVE_URL=http://127.0.0.1:<port> HERMES_LIVE_TOKEN=<token> HERMES_LIVE_PROMPT=1 npm test
 */
const url = process.env.HERMES_LIVE_URL;
const token = process.env.HERMES_LIVE_TOKEN;
const enabled = Boolean(url && token && process.env.HERMES_LIVE_PROMPT === "1");

const newClient = () =>
  new HermesClient({ baseUrl: url as string, token: token as string, webSocketFactory: (u) => new WebSocket(u) as unknown as WebSocketLike });

describe.skipIf(!enabled)("live chat turn", () => {
  it("streams a reply through ChatController, then cleans up", async () => {
    const startedAt = Date.now() / 1000 - 5;
    const client = newClient();
    await client.connect();
    const chat = new ChatController(client);
    try {
      await chat.send("Reply with exactly: ok");
      expect(chat.get().items[0]).toMatchObject({ kind: "user", text: "Reply with exactly: ok" });

      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && !(chat.get().items.some((i) => i.kind === "assistant") && !chat.get().running)) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const s = chat.get();
      expect(s.error).toBeNull();
      expect(s.running).toBe(false);
      const reply = s.items.find((i) => i.kind === "assistant");
      expect(reply).toMatchObject({ kind: "assistant", sealed: true });
      expect((reply as { text: string }).text.toLowerCase()).toContain("ok");
    } finally {
      await chat.close(); // release the live session so it can be deleted
      client.close();
      // Clean up: delete the session(s) this test created (a live session cannot be deleted, so use a fresh connection).
      const cleaner = newClient();
      await cleaner.connect();
      const list = (await cleaner.request("session.list", { limit: 10 })) as {
        sessions?: { id: string; started_at: number; preview?: string; message_count?: number }[];
      };
      for (const s of list.sessions ?? []) {
        // Only this test's own session: recent, tiny, and starting with the exact prompt.
        const mine = s.started_at >= startedAt && (s.message_count ?? 0) <= 2 && (s.preview ?? "").includes("Reply with exactly: ok");
        if (mine) await cleaner.request("session.delete", { session_id: s.id });
      }
      cleaner.close();
    }
  }, 90_000);
});
