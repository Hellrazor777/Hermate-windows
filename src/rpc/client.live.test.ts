import { describe, expect, it } from "vitest";
import { HermesClient, type WebSocketLike } from "./client";
import type { HermesEvent } from "./types";

/**
 * Opt-in test against a real Hermes backend. Skipped unless both variables are set:
 *   HERMES_LIVE_URL=http://127.0.0.1:<port> HERMES_LIVE_TOKEN=<token> npm test
 * Start a throwaway backend with: HERMES_DASHBOARD_SESSION_TOKEN=<token> hermes serve --port 0
 * It makes no model calls and creates no persisted sessions.
 */
const url = process.env.HERMES_LIVE_URL;
const token = process.env.HERMES_LIVE_TOKEN;

describe.skipIf(!url || !token)("live Hermes backend", () => {
  it("connects, advertises server requests, pings and lists profiles", async () => {
    const client = new HermesClient({
      baseUrl: url as string,
      token: token as string,
      // Node 22+ ships a global WebSocket with the same shape.
      webSocketFactory: (u) => new WebSocket(u) as unknown as WebSocketLike,
    });
    const events: HermesEvent[] = [];
    client.onEvent(null, (e) => events.push(e));
    try {
      await client.connect();
      expect(client.serverRequestsEnabled).toBe(true);
      expect(await client.request("gateway.ping")).toEqual({ ok: true });
      const profiles = await client.request("profiles.list");
      expect(Array.isArray(profiles.profiles)).toBe(true);
      await expect(client.request("nonexistent.method")).rejects.toMatchObject({ code: -32601 });
      expect(events.some((e) => e.type === "gateway.ready")).toBe(true);
    } finally {
      client.close();
    }
  });

  it("rejects a wrong token", async () => {
    const client = new HermesClient({
      baseUrl: url as string,
      token: "definitely-wrong",
      webSocketFactory: (u) => new WebSocket(u) as unknown as WebSocketLike,
    });
    await expect(client.connect()).rejects.toBeTruthy();
    client.close();
  });
});
