import { describe, expect, it } from "vitest";
import { HermesClient, type HttpRequest } from "./client";
import { HermesRpcError } from "./types";

function client(reply: { status: number; body: string } | Error | string) {
  const seen: HttpRequest[] = [];
  const c = new HermesClient({
    baseUrl: "http://127.0.0.1:9119",
    token: "tok",
    httpTransport: async (req) => {
      seen.push(req);
      if (reply instanceof Error || typeof reply === "string") throw reply;
      return reply;
    },
  });
  return { c, seen };
}

describe("HermesClient.pluginRequest", () => {
  it("sends the base URL, token and a JSON body, and parses the reply", async () => {
    const { c, seen } = client({ status: 200, body: '{"ok":true}' });
    expect(await c.pluginRequest("POST", "/api/plugins/kanban/tasks", { title: "t" })).toEqual({ ok: true });
    expect(seen[0]).toEqual({ baseUrl: "http://127.0.0.1:9119", token: "tok", method: "POST", path: "/api/plugins/kanban/tasks", body: '{"title":"t"}' });
    expect((await client({ status: 200, body: "{}" }).c.pluginRequest("GET", "/api/plugins/kanban/board"))).toEqual({});
  });

  it("turns an HTTP error into Hermes' own detail", async () => {
    const { c } = client({ status: 409, body: '{"detail":"not valid from here"}' });
    await expect(c.pluginRequest("PATCH", "/api/plugins/kanban/tasks/x", { status: "done" })).rejects.toMatchObject({
      message: "not valid from here",
      code: 409,
    });
    await expect(client({ status: 502, body: "<html>" }).c.pluginRequest("GET", "/x")).rejects.toThrow("HTTP 502");
  });

  it("rejects a reply that is not a JSON object", async () => {
    for (const body of ["", "[1]", "null", "nope"]) {
      await expect(client({ status: 200, body }).c.pluginRequest("GET", "/x")).rejects.toBeInstanceOf(HermesRpcError);
    }
  });

  it("surfaces a transport failure message, including a plain string from Rust", async () => {
    await expect(client("could not reach Hermes").c.pluginRequest("GET", "/x")).rejects.toThrow("could not reach Hermes");
    await expect(client(new Error("boom")).c.pluginRequest("GET", "/x")).rejects.toThrow("boom");
  });

  it("fails closed without a transport", async () => {
    const c = new HermesClient({ baseUrl: "http://127.0.0.1:9119", token: "t" });
    await expect(c.pluginRequest("GET", "/x")).rejects.toThrow(/cannot reach/);
  });
});
