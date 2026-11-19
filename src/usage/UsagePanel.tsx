import { useEffect, useSyncExternalStore } from "react";
import { compact, dollars, PERIODS, type UsageStore } from "./store";

/** Credit balance and token/cost usage per model on the connected Hermes. */
export default function UsagePanel({ store }: { store: UsageStore }) {
  const { period, credits, models, loading } = useSyncExternalStore(store.subscribe, store.get);

  useEffect(() => {
    void store.refresh();
  }, [store]);

  return (
    <section aria-label="Usage">
      <h2>Usage</h2>
      <label>
        Period{" "}
        <select aria-label="Usage period" value={period} disabled={loading} onChange={(e) => void store.refresh(Number(e.target.value) as (typeof PERIODS)[number])}>
          {PERIODS.map((d) => (
            <option key={d} value={d}>
              Last {d} days
            </option>
          ))}
        </select>
      </label>{" "}
      <button disabled={loading} onClick={() => void store.refresh()}>
        {loading ? "Loading…" : "Refresh"}
      </button>

      <h3>Credits</h3>
      {credits?.state === "error" && <p role="alert">{credits.message}</p>}
      {credits?.state === "unavailable" && <p className="muted">This Hermes does not report a credit balance.</p>}
      {credits?.state === "available" && (
        <div>
          <p>
            <strong>{credits.spendable ?? "—"}</strong> spendable
            {credits.plan ? ` · ${credits.plan} plan` : ""}
            {credits.renews ? ` · renews ${credits.renews}` : ""}
            {credits.status && credits.status !== "healthy" ? ` · ${credits.status}` : ""}
          </p>
          <ul style={{ listStyle: "none", padding: 0 }}>
            {credits.bars.map((b) => (
              <li key={b.kind} className="muted">
                {b.kind}: {b.remaining ?? "—"} left of {b.total ?? "—"} ({b.spent ?? "—"} spent)
              </li>
            ))}
          </ul>
        </div>
      )}

      <h3>Models, last {period} days</h3>
      {models?.state === "error" && <p role="alert">{models.message}</p>}
      {models?.state === "ready" && models.models.length === 0 && <p className="muted">No usage in this period.</p>}
      {models?.state === "ready" && models.models.length > 0 && (
        <>
          <p>
            {compact(models.totals.inputTokens + models.totals.cacheReadTokens)} in · {compact(models.totals.outputTokens)} out ·{" "}
            {models.totals.apiCalls} calls · {models.totals.sessions} sessions · est. {dollars(models.totals.estimatedCost)}
            {models.totals.actualCost > 0 ? ` · billed ${dollars(models.totals.actualCost)}` : ""}
          </p>
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>In</th>
                <th>Out</th>
                <th>Calls</th>
                <th>Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {models.models.map((m) => (
                <tr key={`${m.provider ?? ""}/${m.model}`}>
                  <td>
                    {m.model} {m.provider && <span className="muted">({m.provider})</span>}
                  </td>
                  <td>{compact(m.inputTokens + m.cacheReadTokens)}</td>
                  <td>{compact(m.outputTokens)}</td>
                  <td>{m.apiCalls}</td>
                  <td>{dollars(m.estimatedCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">Costs are Hermes' estimates. “In” includes cached input.</p>
        </>
      )}
    </section>
  );
}
