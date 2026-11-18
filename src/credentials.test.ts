import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { credentials } from "./credentials";

beforeEach(() => invoke.mockReset());

describe("credentials", () => {
  it("saves through credential_set", async () => {
    invoke.mockResolvedValue(undefined);
    await credentials.save("conn-1", "tok");
    expect(invoke).toHaveBeenCalledWith("credential_set", { id: "conn-1", secret: "tok" });
  });

  it("loads a stored value and maps missing to null", async () => {
    invoke.mockResolvedValueOnce("tok").mockResolvedValueOnce(null).mockResolvedValueOnce(undefined);
    expect(await credentials.load("conn-1")).toBe("tok");
    expect(await credentials.load("nope")).toBeNull();
    expect(await credentials.load("nope")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("credential_get", { id: "conn-1" });
  });

  it("removes through credential_delete", async () => {
    invoke.mockResolvedValue(undefined);
    await credentials.remove("conn-1");
    expect(invoke).toHaveBeenCalledWith("credential_delete", { id: "conn-1" });
  });

  it("surfaces backend errors", async () => {
    invoke.mockRejectedValue("invalid credential id");
    await expect(credentials.save("bad id", "x")).rejects.toBe("invalid credential id");
  });
});
