import { beforeEach, describe, expect, it, vi } from "vitest";

// A plain function behind the mock (not a spy), so rejections are not tracked as unhandled.
type Impl = (cmd: string, args: unknown) => Promise<unknown>;
let impl: Impl;
const calls: [string, unknown][] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => {
    calls.push([cmd, args]);
    return impl(cmd, args);
  },
}));

import { credentials } from "./credentials";

beforeEach(() => {
  calls.length = 0;
  impl = () => Promise.resolve(undefined);
});

describe("credentials", () => {
  it("saves through credential_set", async () => {
    await credentials.save("conn-1", "tok");
    expect(calls).toEqual([["credential_set", { id: "conn-1", secret: "tok" }]]);
  });

  it("loads a stored value and maps missing to null", async () => {
    impl = (_c, a) => Promise.resolve((a as { id: string }).id === "conn-1" ? "tok" : undefined);
    expect(await credentials.load("conn-1")).toBe("tok");
    expect(await credentials.load("nope")).toBeNull();
    impl = () => Promise.resolve(null);
    expect(await credentials.load("nope")).toBeNull();
    expect(calls[0]).toEqual(["credential_get", { id: "conn-1" }]);
  });

  it("removes through credential_delete", async () => {
    await credentials.remove("conn-1");
    expect(calls).toEqual([["credential_delete", { id: "conn-1" }]]);
  });

  it("surfaces backend errors", async () => {
    // Real Tauri rejects with the Rust command's error string.
    impl = () => Promise.reject("invalid credential id");
    const outcome = await credentials.save("bad id", "x").then(
      () => "resolved",
      (e: unknown) => e,
    );
    expect(outcome).toBe("invalid credential id");
  });
});
