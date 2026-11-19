import { describe, expect, it } from "vitest";
import { HermesRpcError } from "../rpc";
import { compact, dollars, parseCredits, parseModels, UsageStore, type UsageClient } from "./store";

/** `usage.bars` exactly as it answered live. */
const bars = {
  ok: true,
  available: true,
  status: "healthy",
  plan_name: "Free",
  renews_display: "Dec 14, 2026",
  total_spendable_display: "$14.33",
  plan_bar: null,
  topup_bar: { kind: "topup", remaining_display: "$14.33", total_display: "$14.33", spent_display: "$0.00", pct_used: null, fill_fraction: 1 },
};

/** `GET /api/analytics/models` rows as live (trimmed). */
const model = (over: Record<string, unknown> = {}) => ({
  model: "anthropic/claude-haiku-5.5",
  provider: "nous",
  input_tokens: 1496,
  output_tokens: 402538,
  cache_read_tokens: 150593073,
  reasoning_tokens: 132432,
  estimated_cost: 2.318,
  actual_cost: 0,
  sessions: 4,
  api_calls: 621,
  ...over,
});
const analytics = {
  models: [model({ model: "cheap", estimated_cost: 0.5 }), model({ model: "dear", estimated_cost: 9 }), model({ model: "idle", estimated_cost: 0, output_tokens: 0 })],
  totals: { total_input: 1742, total_output: 480648, total_cache_read: 189279214, total_estimated_cost: 18.8, total_actual_cost: 0, total_sessions: 7, total_api_calls: 766 },
  period_days: 30,
};

function fake(opts: { bars?: unknown; models?: unknown }) {
  const calls: string[] = [];
  const client: UsageClient = {
    request: async (method) => {
      calls.push(method);
      if (opts.bars instanceof Error) throw opts.bars;
      return opts.bars as Record<string, never>;
    },
    pluginRequest: async (_m, path) => {
      calls.push(path);
      if (opts.models instanceof Error) throw opts.models;
      return opts.models as Record<string, never>;
    },
  };
  return { client, calls };
}

describe("parseCredits", () => {
  it("reads the live shape, keeping Hermes' own display strings", () => {
    expect(parseCredits(bars)).toEqual({
      state: "available",
      plan: "Free",
      status: "healthy",
      renews: "Dec 14, 2026",
      spendable: "$14.33",
      bars: [{ kind: "topup", remaining: "$14.33", total: "$14.33", spent: "$0.00" }],
    });
  });

  it("is unavailable, never guessed, for anything but available:true", () => {
    for (const r of [{ ok: true, available: false }, { ok: false }, {}, null, "x", [], { available: "yes" }]) {
      expect(parseCredits(r)).toEqual({ state: "unavailable" });
    }
  });
});

describe("parseModels", () => {
  it("sorts by cost, then output tokens, and reads totals", () => {
    const { models, totals } = parseModels(analytics);
    expect(models.map((m) => m.model)).toEqual(["dear", "cheap", "idle"]);
    expect(totals).toMatchObject({ outputTokens: 480648, estimatedCost: 18.8, apiCalls: 766, sessions: 7 });
  });

  it("folds a provider-less row into the one provider row of the same model, but not when it is ambiguous", () => {
    const { models } = parseModels({
      models: [
        model({ model: "m", provider: "nous", api_calls: 10, estimated_cost: 1 }),
        model({ model: "m", provider: null, api_calls: 2, estimated_cost: 0.5 }),
        model({ model: "n", provider: "a", api_calls: 1 }),
        model({ model: "n", provider: "b", api_calls: 1 }),
        model({ model: "n", provider: null, api_calls: 7 }),
      ],
    });
    expect(models.filter((m) => m.model === "m")).toHaveLength(1);
    expect(models.find((m) => m.model === "m")).toMatchObject({ provider: "nous", apiCalls: 12, estimatedCost: 1.5 });
    expect(models.filter((m) => m.model === "n")).toHaveLength(3);
  });

  it("drops junk and treats bad numbers as zero", () => {
    const { models, totals } = parseModels({ models: [null, { provider: "x" }, model({ input_tokens: -5, api_calls: "many" })], totals: { total_input: null } });
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ inputTokens: 0, apiCalls: 0 });
    expect(totals.inputTokens).toBe(0);
    expect(parseModels(undefined)).toEqual({ models: [], totals: expect.objectContaining({ sessions: 0 }) });
  });
});

describe("formatting", () => {
  it("compacts counts", () => {
    expect([0, 999, 1000, 1234, 1742, 480648, 1_742_000, 189_279_214, 2.5e9].map(compact)).toEqual(["0", "999", "1K", "1.2K", "1.7K", "481K", "1.7M", "189M", "2.5B"]);
  });
  it("formats dollars without rounding a tiny cost to zero", () => {
    expect([0, 0.004, 0.01, 2.318, 18.8].map(dollars)).toEqual(["$0.00", "<$0.01", "$0.01", "$2.32", "$18.80"]);
  });
});

describe("UsageStore", () => {
  it("loads credits and models together for the chosen period", async () => {
    const { client, calls } = fake({ bars, models: analytics });
    const store = new UsageStore(client);
    await store.refresh();
    expect(calls.sort()).toEqual(["/api/analytics/models?days=30", "usage.bars"]);
    expect(store.get()).toMatchObject({ period: 30, loading: false, credits: { state: "available" }, models: { state: "ready" } });
    await store.refresh(7);
    expect(calls).toContain("/api/analytics/models?days=7");
    expect(store.get().period).toBe(7);
  });

  it("keeps one source working when the other fails, and says which failed", async () => {
    const a = new UsageStore(fake({ bars: new HermesRpcError("method not found"), models: analytics }).client);
    await a.refresh();
    expect(a.get().credits).toEqual({ state: "error", message: "method not found" });
    expect(a.get().models).toMatchObject({ state: "ready" });
    const b = new UsageStore(fake({ bars, models: new HermesRpcError("This connection cannot reach Hermes' HTTP API.") }).client);
    await b.refresh();
    expect(b.get().credits).toMatchObject({ state: "available" });
    expect(b.get().models).toEqual({ state: "error", message: "This connection cannot reach Hermes' HTTP API." });
  });

  it("an older refresh never overwrites a newer one, and nothing updates after dispose", async () => {
    const waits: ((v: unknown) => void)[] = [];
    const client: UsageClient = {
      request: () => new Promise((r) => waits.push(r)) as never,
      pluginRequest: async () => analytics as never,
    };
    const store = new UsageStore(client);
    const first = store.refresh(7);
    const second = store.refresh(90);
    waits[1]({ ok: true, available: false });
    await second;
    waits[0](bars);
    await first;
    expect(store.get()).toMatchObject({ period: 90, credits: { state: "unavailable" } });

    let notified = 0;
    store.subscribe(() => notified++);
    store.dispose();
    const third = store.refresh();
    waits[2](bars);
    await third;
    expect(notified).toBe(0);
  });
});
