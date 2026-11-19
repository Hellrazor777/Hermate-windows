import type { HermesClient } from "../rpc";

export type UsageClient = Pick<HermesClient, "request" | "pluginRequest">;

export const PERIODS = [7, 30, 90] as const;
export type Period = (typeof PERIODS)[number];

/** A credit bar as Hermes words it. Amounts are Hermes' own display strings: the app never does money math. */
export interface CreditBar {
  kind: string;
  remaining: string | null;
  total: string | null;
  spent: string | null;
}

export type Credits =
  | { state: "available"; plan: string | null; status: string | null; renews: string | null; spendable: string | null; bars: CreditBar[] }
  /** This Hermes has no credit view (for example another provider): not an error, and nothing is guessed. */
  | { state: "unavailable" }
  | { state: "error"; message: string };

export interface ModelUsage {
  model: string;
  provider: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  /** Hermes' estimate in US dollars; `actualCost` is what a provider billed, when it reports that. */
  estimatedCost: number;
  actualCost: number;
  sessions: number;
  apiCalls: number;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  estimatedCost: number;
  actualCost: number;
  sessions: number;
  apiCalls: number;
}

export type Models = { state: "ready"; models: ModelUsage[]; totals: UsageTotals } | { state: "error"; message: string };

export interface UsageSnapshot {
  period: Period;
  credits: Credits | null;
  models: Models | null;
  loading: boolean;
}

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** `usage.bars`: the credit view. Fails closed: anything but `available: true` is "unavailable". */
export function parseCredits(res: unknown): Credits {
  const o = rec(res);
  if (!o || o.ok === false || o.available !== true) return { state: "unavailable" };
  const bars: CreditBar[] = [];
  for (const key of ["plan_bar", "topup_bar"]) {
    const b = rec(o[key]);
    if (!b) continue;
    bars.push({ kind: str(b.kind) ?? key.replace("_bar", ""), remaining: str(b.remaining_display), total: str(b.total_display), spent: str(b.spent_display) });
  }
  return {
    state: "available",
    plan: str(o.plan_name),
    status: str(o.status),
    renews: str(o.renews_display),
    spendable: str(o.total_spendable_display),
    bars,
  };
}

/**
 * Hermes keeps a model's calls with no recorded provider in a row of their own, which shows the same model twice.
 * When exactly one provider row has the same model name, add the provider-less row into it (display only; totals
 * come from Hermes). With several providers it is ambiguous, so the row stays separate.
 */
function foldProviderless(models: ModelUsage[]): ModelUsage[] {
  const out: ModelUsage[] = [];
  const owners = new Map<string, ModelUsage[]>();
  for (const m of models) if (m.provider) owners.set(m.model, [...(owners.get(m.model) ?? []), m]);
  for (const m of models) {
    const target = m.provider ? undefined : owners.get(m.model)?.length === 1 ? owners.get(m.model)![0] : undefined;
    if (!target) {
      out.push(m);
      continue;
    }
    target.inputTokens += m.inputTokens;
    target.outputTokens += m.outputTokens;
    target.cacheReadTokens += m.cacheReadTokens;
    target.reasoningTokens += m.reasoningTokens;
    target.estimatedCost += m.estimatedCost;
    target.actualCost += m.actualCost;
    target.sessions += m.sessions;
    target.apiCalls += m.apiCalls;
  }
  return out;
}

export function parseModels(res: unknown): { models: ModelUsage[]; totals: UsageTotals } {
  const o = rec(res);
  const models: ModelUsage[] = [];
  for (const r of Array.isArray(o?.models) ? (o.models as unknown[]) : []) {
    const m = rec(r);
    const model = m && str(m.model);
    if (!m || !model) continue;
    models.push({
      model,
      provider: str(m.provider),
      inputTokens: num(m.input_tokens),
      outputTokens: num(m.output_tokens),
      cacheReadTokens: num(m.cache_read_tokens),
      reasoningTokens: num(m.reasoning_tokens),
      estimatedCost: num(m.estimated_cost),
      actualCost: num(m.actual_cost),
      sessions: num(m.sessions),
      apiCalls: num(m.api_calls),
    });
  }
  const merged = foldProviderless(models);
  models.length = 0;
  models.push(...merged);
  models.sort((a, b) => b.estimatedCost + b.actualCost - (a.estimatedCost + a.actualCost) || b.outputTokens - a.outputTokens || a.model.localeCompare(b.model));
  const t = rec(o?.totals);
  return {
    models,
    totals: {
      inputTokens: num(t?.total_input),
      outputTokens: num(t?.total_output),
      cacheReadTokens: num(t?.total_cache_read),
      estimatedCost: num(t?.total_estimated_cost),
      actualCost: num(t?.total_actual_cost),
      sessions: num(t?.total_sessions),
      apiCalls: num(t?.total_api_calls),
    },
  };
}

/** 1234 -> "1.2K", 1_742_000 -> "1.7M". */
export function compact(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const units: [number, string][] = [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [size, suffix] of units) if (n >= size) return `${(n / size).toFixed(n / size >= 100 ? 0 : 1).replace(/\.0$/, "")}${suffix}`;
  return String(n);
}

export const dollars = (n: number): string => (n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/** Credit balance and per-model usage on the connected Hermes. The two sources fail independently. */
export class UsageStore {
  private snapshot: UsageSnapshot = { period: 30, credits: null, models: null, loading: false };
  private listeners = new Set<() => void>();
  private disposed = false;
  private latest = 0;

  constructor(private readonly client: UsageClient) {}

  get = (): UsageSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  async refresh(period: Period = this.snapshot.period): Promise<void> {
    const mine = ++this.latest;
    this.set({ period, loading: true });
    const [credits, models] = await Promise.all([
      this.client.request("usage.bars", {}).then(
        (res): Credits => parseCredits(res),
        (e): Credits => ({ state: "error", message: message(e, "Could not load the credit balance.") }),
      ),
      this.client.pluginRequest("GET", `/api/analytics/models?days=${period}`).then(
        (res): Models => ({ state: "ready", ...parseModels(res) }),
        (e): Models => ({ state: "error", message: message(e, "Could not load model usage.") }),
      ),
    ]);
    if (mine === this.latest) this.set({ credits, models, loading: false });
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private set(patch: Partial<UsageSnapshot>): void {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }
}
